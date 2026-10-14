// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { planOfflineSubscriptionMigration } from '../../experiments/subscription-transactions/migration.js';
import { StorageFactory } from '../../functions/storage-adapter.js';
import {
    captureSubscriptionIdentity,
    commitRuntimeObservation,
    createSubscriptionProtocol,
} from '../../functions/services/subscription-protocol/index.js';
import { compileCommit } from '../../functions/services/subscription-protocol/sql.js';

const runtimes = [];
afterEach(async () => {
    for (const fixture of runtimes.splice(0)) {
        await fixture.runtime.dispose();
        expect(fixture.outbound).toEqual([]);
    }
});
const item = { id: 'a', url: 'https://fixture.invalid/a', name: 'fixture', enabled: true };
const group = { id: 'g', subscriptions: ['a'], manualNodes: [] };
const rows = (items) => items.map((entry) => ({ id: entry.id, data: JSON.stringify(entry) }));
const migration = (overrides = {}) =>
    planOfflineSubscriptionMigration({
        subscriptions: rows([item]),
        profiles: rows([group]),
        settings: [],
        authority: 'fixture-authority',
        epoch: 'fixture-epoch',
        ...overrides,
    });
async function create({
    subscriptions = rows([item]),
    profiles = rows([group]),
    settings = [],
} = {}) {
    const fixture = { outbound: [] };
    fixture.runtime = new Miniflare({
        modules: true,
        compatibilityDate: '2025-08-01',
        script: 'export default { fetch() { return new Response("fixture"); } };',
        d1Databases: { DB: 'subscription-runtime-fixture' },
        d1Persist: false,
        host: '127.0.0.1',
        port: 0,
        outboundService(request) {
            fixture.outbound.push(new URL(request.url).origin);
            return new Response('forbidden', { status: 403 });
        },
    });
    runtimes.push(fixture);
    const db = await fixture.runtime.getD1Database('DB');
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
    for (const sql of readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8')
        .split(';')
        .filter((text) => text.trim()))
        await db.prepare(sql).run();
    for (const [table, values] of Object.entries({ subscriptions, profiles }))
        for (const row of values)
            await db
                .prepare(`INSERT INTO ${table}(id,data,created_at,updated_at) VALUES(?,?,?,?)`)
                .bind(row.id, row.data, row.created_at ?? null, row.updated_at ?? null)
                .run();
    for (const row of settings)
        await db
            .prepare('INSERT INTO settings(key,value,created_at,updated_at) VALUES(?,?,?,?)')
            .bind(row.key, row.value, row.created_at ?? null, row.updated_at ?? null)
            .run();
    return {
        db,
        env: {
            MISUB_DB: db,
            MISUB_SUBSCRIPTION_PROTOCOL: 'd1-v1',
            MISUB_SUBSCRIPTION_AUTHORITY: 'fixture-authority',
        },
    };
}
const execute = (db, statements) =>
    db.batch(statements.map(({ sql, args }) => db.prepare(sql).bind(...args)));

describe('offline physical-row migration planner', () => {
    it('deterministically expands main and identical rows while preserving unknown data', async () => {
        const original = { ...item, unknownLegacyField: { retained: true }, sortIndex: 7 };
        const plan = await migration({
            subscriptions: [{ id: 'main', data: JSON.stringify([original]) }, ...rows([original])],
        });
        expect(plan.counts).toMatchObject({
            subscriptions: 1,
            profiles: 1,
            identicalDuplicates: 1,
            legacyRows: 1,
        });
        expect(plan.snapshot.subscriptions[0]).toMatchObject(original);
        expect(
            (
                await migration({
                    subscriptions: [
                        { id: 'main', data: JSON.stringify([original]) },
                        ...rows([original]),
                    ],
                })
            ).targetDigest
        ).toBe(plan.targetDigest);
    });

    it.each([
        [{ id: 'main', data: JSON.stringify([item]) }, ...rows([{ ...item, name: 'conflict' }])],
        [{ id: 'a', data: 'invalid-json' }],
        [{ id: 'other', data: JSON.stringify(item) }],
        [{ id: 'main', data: JSON.stringify({ id: 'main', url: 'https://fixture.invalid/main' }) }],
        [{ id: 'main', data: JSON.stringify([{ id: 'main' }]) }],
    ])(
        'stops on ambiguous or corrupt physical rows without executing SQL',
        async (subscriptions) => {
            await expect(migration({ subscriptions })).rejects.toThrow();
        }
    );

    it('rejects dangling references instead of silently dropping them', async () => {
        await expect(
            migration({ profiles: rows([{ id: 'g', manualNodes: ['missing'] }]) })
        ).rejects.toThrow('invalid_reference');
    });
});

describe('actual local D1 runtime and migration batches', () => {
    it('guards all source domains in one D1 batch and admits only one concurrent migration', async () => {
        const settings = [
            {
                key: 'main',
                value: ' { "storageType":"kv", "unknown":"retain" } ',
                created_at: '2001-01-01 00:00:00',
                updated_at: '2002-01-01 00:00:00',
            },
            {
                key: 'misub_rule_templates_v1',
                value: '[{"id":"r","unknown":true}]',
                created_at: '2003-01-01 00:00:00',
                updated_at: '2004-01-01 00:00:00',
            },
            {
                key: 'other',
                value: 'opaque',
                created_at: '2005-01-01 00:00:00',
                updated_at: '2006-01-01 00:00:00',
            },
        ];
        const { db, env } = await create({ settings });
        const plan = await migration({ settings });
        await db.prepare("UPDATE settings SET value='changed' WHERE key='other'").run();
        await expect(execute(db, plan.statements)).rejects.toThrow('migration_source_mismatch');
        expect(
            await db
                .prepare(
                    "SELECT count(*) n FROM sqlite_master WHERE name LIKE 'subscription_protocol_%'"
                )
                .first('n')
        ).toBe(0);
        expect(
            await db.prepare("SELECT value FROM settings WHERE key='other'").first('value')
        ).toBe('changed');
        await db.prepare("UPDATE settings SET value='opaque' WHERE key='other'").run();
        const concurrent = await Promise.allSettled([
            execute(db, plan.statements),
            execute(db, plan.statements),
        ]);
        expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(concurrent.filter((r) => r.status === 'rejected')).toHaveLength(1);
        expect((await db.prepare('SELECT * FROM settings ORDER BY key').all()).results).toEqual(
            plan.targetRows.settings
        );
        const storage = StorageFactory.createAdapter(env, 'd1');
        expect((await storage.readDomainSnapshot()).settings).toMatchObject({
            storageType: 'd1',
            unknown: 'retain',
        });
        await expect(
            db.prepare("UPDATE settings SET value='{}' WHERE key='main'").run()
        ).rejects.toThrow('subscription_legacy_write_blocked');
        await storage.commitSubscriptionOperations({
            baseVersion: { epoch: 'fixture-epoch', revision: 0 },
            operationId: 'after-migration',
            operations: [
                {
                    type: 'update',
                    collection: 'subscriptions',
                    id: 'a',
                    fields: { name: 'newly committed' },
                },
            ],
        });
        await expect(execute(db, plan.statements)).rejects.toThrow();
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(1);
        expect((await storage.readSubscriptionSnapshot()).subscriptions[0].name).toBe(
            'newly committed'
        );
    });

    it('serializes a real D1 legacy writer against the migration boundary', async () => {
        const { db, env } = await create();
        const plan = await migration();
        const results = await Promise.allSettled([
            execute(db, plan.statements),
            db
                .prepare("UPDATE subscriptions SET data=? WHERE id='a'")
                .bind(JSON.stringify({ ...item, name: 'legacy winner' }))
                .run(),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        if (results[0].status === 'fulfilled') {
            expect(results[1].reason.message).toContain('subscription_legacy_write_blocked');
            expect(
                (await StorageFactory.createAdapter(env, 'd1').readSubscriptionSnapshot())
                    .subscriptions[0].name
            ).toBe('fixture');
        } else {
            expect(results[0].reason.message).toContain('migration_source_mismatch');
            expect(
                JSON.parse(
                    await db.prepare("SELECT data FROM subscriptions WHERE id='a'").first('data')
                ).name
            ).toBe('legacy winner');
        }
    });

    it('checks Telegram preview expiry using the real D1 transaction clock', async () => {
        const { db, env } = await create();
        await execute(db, (await migration()).statements);
        const fixedClock = Date.now() - 60000;
        const storage = createSubscriptionProtocol(env, { now: () => fixedClock });
        const preview = await storage.createTelegramPreview({
            id: 'native-clock',
            actorId: '1',
            chatId: '1',
            sourceDigest: 'a'.repeat(64),
            baseVersion: { epoch: 'fixture-epoch', revision: 0 },
            operations: [
                { type: 'update', collection: 'subscriptions', id: 'a', fields: { name: 'new' } },
            ],
        });
        // The request clock remains before expiry; only the database clock is later.
        await db
            .prepare('UPDATE subscription_protocol_previews SET expires_at=? WHERE id=?')
            .bind(fixedClock + 1, preview.id)
            .run();
        await expect(storage.commitTelegramPreview(preview)).rejects.toThrow('preview_expired');
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
        await db
            .prepare('UPDATE subscription_protocol_previews SET expires_at=? WHERE id=?')
            .bind(Date.now() + 600000, preview.id)
            .run();
        expect((await storage.commitTelegramPreview(preview)).receipt.version.revision).toBe(1);
    });
    it('rejects a settings race inside the real D1 runtime commit boundary', async () => {
        const { db, env } = await create();
        await execute(db, (await migration()).statements);
        const storage = StorageFactory.createAdapter(
            {
                ...env,
                MISUB_DB: {
                    prepare: (...args) => db.prepare(...args),
                    batch: async (statements) => {
                        await StorageFactory.createAdapter(env, 'd1').commitDomainOperations({
                            baseVersion: { epoch: 'fixture-epoch', revision: 0 },
                            operationId: 'settings-race',
                            domains: { settings: { builtinSkipCertVerify: true } },
                        });
                        return db.batch(statements);
                    },
                },
            },
            'd1'
        );
        const before = await storage.readSubscriptionSnapshot();
        expect(
            await commitRuntimeObservation(storage, {
                id: 'a',
                operationId: 'policy-race',
                epoch: 'fixture-epoch',
                requestPolicy: before.requestPolicy,
                identity: await captureSubscriptionIdentity(before.subscriptions[0]),
                observedAt: 10,
                fields: { nodeCount: 4 },
            })
        ).toEqual({ applied: false, reason: 'identity_conflict' });
        const after = await storage.readSubscriptionSnapshot();
        expect(after.version).toEqual({ ...before.version, revision: 1 });
        expect(after.subscriptions).toEqual(before.subscriptions);
        expect(after.requestPolicy).toBe(1);
        expect(
            await db.prepare('SELECT count(*) n FROM subscription_protocol_receipts').first('n')
        ).toBe(1);
        expect(
            await db.prepare('SELECT count(*) n FROM subscription_protocol_gate').first('n')
        ).toBe(0);
    });

    it('rolls back every migration boundary including schema changes, then verifies authority', async () => {
        const source = [{ id: 'main', data: JSON.stringify([item]) }];
        const { db, env } = await create({ subscriptions: source });
        const plan = await migration({ subscriptions: source });
        for (let index = 0; index < plan.statements.length; index++) {
            const statements = [...plan.statements];
            statements.splice(index, 0, { sql: "SELECT json('invalid-fixture')", args: [] });
            await expect(execute(db, statements)).rejects.toThrow();
            expect(await db.prepare('SELECT id,data FROM subscriptions').all()).toMatchObject({
                results: source,
            });
            expect(
                await db
                    .prepare(
                        "SELECT count(*) n FROM sqlite_master WHERE name='subscription_protocol_meta'"
                    )
                    .first('n')
            ).toBe(0);
        }
        await execute(db, plan.statements);
        const storage = StorageFactory.createAdapter(env, 'd1');
        const snapshot = await storage.readSubscriptionSnapshot();
        expect(snapshot.version).toEqual({ epoch: 'fixture-epoch', revision: 0 });
        expect(snapshot.subscriptions).toMatchObject([item]);
        await expect(execute(db, plan.statements)).rejects.toThrow();
        expect(await storage.readSubscriptionSnapshot()).toEqual(snapshot);
    }, 15000);

    it('serializes real runtime batches, rejects all partial prefixes and legacy SQL', async () => {
        const { db, env } = await create();
        await execute(db, (await migration()).statements);
        const left = StorageFactory.createAdapter(env, 'd1'),
            right = StorageFactory.createAdapter(env, 'd1');
        const request = (operationId, name) => ({
            operationId,
            baseVersion: { epoch: 'fixture-epoch', revision: 0 },
            operations: [
                { type: 'update', collection: 'subscriptions', id: 'a', fields: { name } },
            ],
        });
        const results = await Promise.allSettled([
            left.commitSubscriptionOperations(request('left', 'left')),
            right.commitSubscriptionOperations(request('right', 'right')),
        ]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.find(({ status }) => status === 'rejected').reason.code).toBe(
            'revision_conflict'
        );
        const winner = results.find(({ status }) => status === 'fulfilled').value;
        const winningRequest = request(
            winner.receipt.operationId,
            winner.snapshot.subscriptions[0].name
        );
        expect((await left.commitSubscriptionOperations(winningRequest)).receipt).toEqual(
            winner.receipt
        );
        await expect(
            db.prepare("INSERT OR REPLACE INTO subscriptions(id,data) VALUES('main','[]')").run()
        ).rejects.toThrow('subscription_legacy_write_blocked');
        const snapshot = await left.readSubscriptionSnapshot();
        const sub = snapshot.subscriptions[0];
        const observation = {
            id: 'a',
            operationId: 'runtime',
            identity: await captureSubscriptionIdentity(sub),
            epoch: 'fixture-epoch',
            requestPolicy: 0,
            observedAt: 10,
            fields: { nodeCount: 4 },
        };
        expect((await commitRuntimeObservation(left, observation)).applied).toBe(true);
        expect((await commitRuntimeObservation(left, observation)).replayed).toBe(true);
        const before = await left.readSubscriptionSnapshot();
        const plan = compileCommit({
            authority: 'fixture-authority',
            baseVersion: before.version,
            operationId: 'partial',
            digest: 'a'.repeat(64),
            next: before,
            now: 1000,
        });
        for (let length = 2; length <= 8; length++) {
            await expect(execute(db, plan.slice(0, length))).rejects.toThrow('FOREIGN KEY');
            expect(await left.readSubscriptionSnapshot()).toEqual(before);
        }
        await expect(execute(db, [...plan.slice(0, 6), plan[8]])).rejects.toThrow(
            'subscription_invalid_operation'
        );
        expect(await left.readSubscriptionSnapshot()).toEqual(before);
    });
});
