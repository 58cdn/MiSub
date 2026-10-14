// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planOfflineSubscriptionMigration } from '../../experiments/subscription-transactions/migration.js';
import {
    hashValue,
    PROTOCOL_LIMITS,
} from '../../functions/services/subscription-protocol/operations.js';

const handles = [];
const directories = [];
afterEach(() => {
    for (const db of handles.splice(0)) {
        try {
            db.close();
        } catch {}
    }
    for (const dir of directories.splice(0)) {
        // Only the explicitly created synthetic database and its SQLite sidecars.
        for (const name of [
            'fixture.sqlite',
            'fixture.sqlite-journal',
            'fixture.sqlite-wal',
            'fixture.sqlite-shm',
        ])
            try {
                unlinkSync(join(dir, name));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        rmdirSync(dir);
    }
});
const metadata = { authority: 'offline-fixture', epoch: 'offline-epoch' };
const physical = (id, data) => ({
    id,
    data: JSON.stringify(data),
    created_at: '2001-01-01',
    updated_at: '2002-02-02',
});
const item = { id: 'a', url: 'https://fixture.invalid/a', unknown: { nested: ['retained'] } };
function sourceRows() {
    return {
        subscriptions: [physical('main', [item])],
        profiles: [physical('g', { id: 'g', subscriptions: ['a'], unknownGroup: 'retained' })],
        settings: [
            {
                key: 'main',
                value: ' { "storageType": "kv", "unknown": {"retained":true} } ',
                created_at: '2001-01-01 00:00:00',
                updated_at: '2002-01-01 00:00:00',
            },
            {
                key: 'misub_rule_templates_v1',
                value: '[{"id":"r","content":"fixture","unknownRule":true}]',
                created_at: '2003-01-01 00:00:00',
                updated_at: '2004-01-01 00:00:00',
            },
            {
                key: 'unrelated',
                value: 'opaque non-JSON bytes',
                created_at: '2005-01-01 00:00:00',
                updated_at: '2006-01-01 00:00:00',
            },
        ],
    };
}
const plan = (source = sourceRows()) =>
    planOfflineSubscriptionMigration({ ...metadata, ...source });
function database(source = sourceRows(), path = ':memory:', transformSchema = (sql) => sql) {
    const db = new DatabaseSync(path);
    handles.push(db);
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(transformSchema(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')));
    for (const table of ['subscriptions', 'profiles'])
        for (const row of source[table])
            db.prepare(`INSERT INTO ${table}(id,data,created_at,updated_at) VALUES(?,?,?,?)`).run(
                row.id,
                row.data,
                row.created_at ?? null,
                row.updated_at ?? null
            );
    for (const row of source.settings)
        db.prepare('INSERT INTO settings(key,value,created_at,updated_at) VALUES(?,?,?,?)').run(
            row.key,
            row.value,
            row.created_at ?? null,
            row.updated_at ?? null
        );
    return db;
}
function snapshot(db) {
    return Object.fromEntries(
        ['subscriptions', 'profiles', 'settings'].map((table) => [
            table,
            db
                .prepare(`SELECT * FROM ${table} ORDER BY ${table === 'settings' ? 'key' : 'id'}`)
                .all()
                .map((row) => ({ ...row })),
        ])
    );
}
function execute(db, migration, hook = () => {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
        migration.statements.forEach(({ sql, args }, index) => {
            hook(index);
            db.prepare(sql).run(...args);
        });
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
const protocolCount = (db) =>
    db
        .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'subscription_protocol_%' OR name='subscription_migration_guard'"
        )
        .get().n;

describe('offline migration admission and recovery', () => {
    it('preserves unknown business fields, all settings bytes and physical timestamps on the actual repository schema', async () => {
        const source = sourceRows(),
            db = database(source),
            migration = await plan(source);
        const before = snapshot(db);
        execute(db, migration);
        const after = snapshot(db);
        expect(after).toEqual(migration.targetRows);
        expect(await hashValue(after, PROTOCOL_LIMITS.transactionBytes)).toBe(
            migration.targetRowsDigest
        );
        expect(after.settings).toEqual(before.settings);
        expect(JSON.parse(after.subscriptions[0].data)).toMatchObject(item);
        expect(after.subscriptions[0]).toMatchObject({
            created_at: '2001-01-01',
            updated_at: '2002-02-02',
        });
        expect(JSON.parse(after.profiles[0].data).unknownGroup).toBe('retained');
        expect(() => execute(db, migration)).toThrow();
        expect(snapshot(db)).toEqual(after);
    });

    it.each([
        ['subscription add', 'INSERT INTO subscriptions(id,data) VALUES(\'b\',\'{"id":"b"}\')'],
        ['subscription edit', "UPDATE subscriptions SET data='[]' WHERE id='main'"],
        ['subscription delete', 'DELETE FROM subscriptions'],
        ['profile add', 'INSERT INTO profiles(id,data) VALUES(\'h\',\'{"id":"h"}\')'],
        ['profile edit', 'UPDATE profiles SET data=\'{"id":"g","subscriptions":[]}\''],
        ['profile delete', 'DELETE FROM profiles'],
        ['settings add', "INSERT INTO settings(key,value) VALUES('new','value')"],
        ['settings edit', "UPDATE settings SET value='{}' WHERE key='main'"],
        ['settings delete', "DELETE FROM settings WHERE key='unrelated'"],
        ['physical timestamp', "UPDATE subscriptions SET updated_at='changed'"],
        ['unknown target column', 'ALTER TABLE subscriptions ADD COLUMN custom TEXT'],
        [
            'unknown generated column',
            'ALTER TABLE subscriptions ADD COLUMN future_generated TEXT GENERATED ALWAYS AS (id) VIRTUAL',
        ],
    ])('rejects a stale source or unsupported layout: %s', async (_name, change) => {
        const source = sourceRows(),
            db = database(source),
            migration = await plan(source);
        db.exec(change);
        const before = snapshot(db);
        expect(() => execute(db, migration)).toThrow('migration_source_mismatch');
        expect(snapshot(db)).toEqual(before);
        expect(protocolCount(db)).toBe(0);
    });

    it('rejects an empty or different target instead of importing over it', async () => {
        const migration = await plan(),
            db = database({ subscriptions: [], profiles: [], settings: [] });
        expect(() => execute(db, migration)).toThrow('migration_source_mismatch');
        expect(protocolCount(db)).toBe(0);
        expect(snapshot(db)).toEqual({ subscriptions: [], profiles: [], settings: [] });
    });

    it('compares raw strings with BINARY even if a target column uses NOCASE', async () => {
        const source = sourceRows();
        const db = database(source, ':memory:', (sql) =>
            sql.replace('value TEXT NOT NULL', 'value TEXT COLLATE NOCASE NOT NULL')
        );
        const migration = await plan(source);
        db.exec("UPDATE settings SET value='Opaque non-JSON bytes' WHERE key='unrelated'");
        const before = snapshot(db);
        expect(() => execute(db, migration)).toThrow('migration_source_mismatch');
        expect(snapshot(db)).toEqual(before);
        expect(protocolCount(db)).toBe(0);
    });

    it('rejects a same-column layout without its physical primary key', async () => {
        const source = sourceRows();
        const db = database(source, ':memory:', (sql) =>
            sql.replaceAll('id TEXT PRIMARY KEY', 'id TEXT')
        );
        const migration = await plan(source),
            before = snapshot(db);
        expect(() => execute(db, migration)).toThrow('migration_source_mismatch');
        expect(snapshot(db)).toEqual(before);
        expect(protocolCount(db)).toBe(0);
    });

    it('uses SQLite BINARY UTF-8 ordering for Unicode physical keys and readback digests', async () => {
        const source = sourceRows();
        source.settings.push(
            { key: '\uE000', value: 'first' },
            { key: '\u{10000}', value: 'second' }
        );
        const db = database(source),
            migration = await plan(source);
        execute(db, migration);
        expect(snapshot(db)).toEqual(migration.targetRows);
        expect(await hashValue(snapshot(db), PROTOCOL_LIMITS.transactionBytes)).toBe(
            migration.targetRowsDigest
        );
    });

    it('rolls back unexpected legacy trigger mutations instead of accepting a changed target', async () => {
        const source = sourceRows(),
            db = database(source),
            migration = await plan(source);
        db.exec(
            "CREATE TRIGGER legacy_side_effect AFTER INSERT ON subscriptions BEGIN UPDATE settings SET value='changed' WHERE key='unrelated'; END"
        );
        const before = snapshot(db);
        expect(() => execute(db, migration)).toThrow('migration_source_mismatch');
        expect(snapshot(db)).toEqual(before);
        expect(protocolCount(db)).toBe(0);
    });

    it('freezes caller inputs before its first await and ignores physical query order', async () => {
        const source = sourceRows(),
            baseline = structuredClone(source);
        const pending = plan(source);
        source.subscriptions[0].data = '[]';
        source.settings[0].value = '{}';
        source.profiles.push(physical('new', { id: 'new' }));
        const migration = await pending,
            expected = await plan(baseline);
        expect(migration).toEqual(expected);
        for (const rows of Object.values(baseline)) rows.reverse();
        expect(await plan(baseline)).toEqual(expected);
    });

    it.each([
        [
            'missing settings',
            (s) => {
                delete s.settings;
            },
        ],
        [
            'duplicate physical ID',
            (s) => {
                s.subscriptions.push({ ...s.subscriptions[0] });
            },
        ],
        [
            'unknown physical field',
            (s) => {
                s.subscriptions[0].extra = 'do not drop';
            },
        ],
        [
            'invalid main',
            (s) => {
                s.settings[0].value = 'invalid';
            },
        ],
        [
            'null main',
            (s) => {
                s.settings[0].value = 'null';
            },
        ],
        [
            'array main',
            (s) => {
                s.settings[0].value = '[]';
            },
        ],
        [
            'invalid rules',
            (s) => {
                s.settings[1].value = '{}';
            },
        ],
        [
            'duplicate rules',
            (s) => {
                s.settings[1].value = '[{"id":"r"},{"id":"r"}]';
            },
        ],
        [
            'duplicate settings',
            (s) => {
                s.settings.push({ ...s.settings[0] });
            },
        ],
        [
            'ambiguous duplicate timestamps',
            (s) => {
                s.subscriptions.push({ ...physical('a', item), updated_at: 'different' });
            },
        ],
        [
            'reserved runtime metadata',
            (s) => {
                s.subscriptions[0].data = JSON.stringify([
                    { ...item, _writeGeneration: 'existing' },
                ]);
            },
        ],
    ])(
        'refuses unsupported input without producing an executable plan: %s',
        async (_name, change) => {
            const source = sourceRows();
            change(source);
            await expect(plan(source)).rejects.toThrow();
        }
    );

    it('rolls back at every statement boundary and retries the same complete plan', async () => {
        const source = sourceRows(),
            db = database(source),
            migration = await plan(source);
        const before = snapshot(db);
        for (let failAt = 0; failAt <= migration.statements.length; failAt++) {
            db.exec('BEGIN IMMEDIATE');
            try {
                for (let i = 0; i <= migration.statements.length; i++) {
                    if (i === failAt) throw new Error('synthetic interruption');
                    if (i < migration.statements.length) {
                        const { sql, args } = migration.statements[i];
                        db.prepare(sql).run(...args);
                    }
                }
            } catch (error) {
                expect(error.message).toBe('synthetic interruption');
            } finally {
                db.exec('ROLLBACK');
            }
            expect(snapshot(db)).toEqual(before);
            expect(protocolCount(db)).toBe(0);
        }
        execute(db, migration);
        expect(snapshot(db)).toEqual(migration.targetRows);
    });

    it('recovers an uncommitted connection interruption, then reconciles a lost successful response without resetting data', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'misub-offline-migration-'));
        directories.push(dir);
        const path = join(dir, 'fixture.sqlite'),
            source = sourceRows();
        const first = database(source, path),
            migration = await plan(source);
        first.exec('BEGIN IMMEDIATE');
        const deleteIndex = migration.statements.findIndex(
            ({ sql }) => sql === 'DELETE FROM subscriptions'
        );
        for (const { sql, args } of migration.statements.slice(0, deleteIndex + 1))
            first.prepare(sql).run(...args);
        first.close();
        const reopened = new DatabaseSync(path);
        handles.push(reopened);
        expect(snapshot(reopened)).toEqual(snapshot(database(source)));
        expect(protocolCount(reopened)).toBe(0);
        execute(reopened, migration);
        reopened.close(); // Simulate no acknowledgement after a committed transaction.
        const confirmed = new DatabaseSync(path);
        handles.push(confirmed);
        expect(() => execute(confirmed, migration)).toThrow();
        expect(await hashValue(snapshot(confirmed), PROTOCOL_LIMITS.transactionBytes)).toBe(
            migration.targetRowsDigest
        );
        expect(
            confirmed
                .prepare(
                    'SELECT authority,schema_version,epoch,revision FROM subscription_protocol_meta'
                )
                .get()
        ).toMatchObject({ ...metadata, schema_version: 2, revision: 0 });
    });

    it('serializes a second legacy connection during migration and rejects its write after activation', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'misub-offline-migration-'));
        directories.push(dir);
        const path = join(dir, 'fixture.sqlite'),
            source = sourceRows();
        const primary = database(source, path),
            legacy = new DatabaseSync(path);
        handles.push(legacy);
        legacy.exec('PRAGMA busy_timeout=1');
        const migration = await plan(source);
        execute(primary, migration, (index) => {
            if (index === 4)
                expect(() => legacy.exec("UPDATE subscriptions SET data='[]'")).toThrow(/locked/);
        });
        expect(() => legacy.exec("UPDATE subscriptions SET data='[]'")).toThrow(
            'subscription_legacy_write_blocked'
        );
        expect(snapshot(primary)).toEqual(migration.targetRows);
    });
});
