// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import {
    MODEL_SCHEMA,
    MODEL_READ,
    compileSnapshotCommit,
} from '../../experiments/subscription-transactions/model.js';

const databases = [],
    paths = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    paths.splice(0).forEach((path) => {
        if (
            dirname(resolve(path)) !== resolve(tmpdir()) ||
            !basename(path).startsWith('misub-atomic-model-')
        ) {
            throw new Error('unexpected fixture path');
        }
        rmSync(path, { recursive: true });
    });
});
function open(path = ':memory:') {
    const db = new DatabaseSync(path);
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    databases.push(db);
    return db;
}
function create(path) {
    const db = open(path);
    MODEL_SCHEMA.forEach((sql) => db.exec(sql));
    db.prepare('INSERT INTO model_meta VALUES(1,?,0)').run('epoch-a');
    return db;
}
// Same precompiled SQL statements proposed for D1 batch; no JS reads/mutations inside it.
function batch(db, plan, failAt = -1) {
    db.exec('BEGIN IMMEDIATE');
    try {
        let result;
        plan.forEach(({ sql, args }, index) => {
            if (index === failAt) db.prepare("SELECT json('invalid-fixture-json')").get();
            const stmt = db.prepare(sql);
            result = stmt.columns().length ? stmt.all(...args) : stmt.run(...args);
        });
        db.exec('COMMIT');
        return result;
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
const next = (ids = ['a']) => ({
    subscriptions: ids.map((id) => ({ id, name: id, url: `https://fixture.invalid/${id}` })),
    profiles: [{ id: 'group', subscriptions: ids }],
});
const plan = (overrides = {}) =>
    compileSnapshotCommit({
        backend: 'd1-model',
        baseVersion: { epoch: 'epoch-a', revision: 0 },
        operationId: 'operation-a',
        next: next(),
        ...overrides,
    });
const snapshot = (db) => ({ ...db.prepare(MODEL_READ).get() });
const count = (db, table) => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

describe('offline subscription atomic SQL model', () => {
    it('commits both collections, version and non-sensitive receipt together', () => {
        const db = create();
        const [receipt] = batch(db, plan());
        expect(receipt).toMatchObject({
            epoch: 'epoch-a',
            revision: 1,
            subscriptions: 1,
            profiles: 1,
        });
        expect(JSON.stringify(receipt)).not.toContain('fixture.invalid');
        expect(snapshot(db)).toMatchObject({ epoch: 'epoch-a', revision: 1 });
        expect(count(db, 'model_gate')).toBe(0);
    });

    it.each(Array.from({ length: 9 }, (_, i) => i))(
        'rolls back every batch position %i',
        (index) => {
            const db = create();
            batch(db, plan());
            const before = snapshot(db);
            expect(() =>
                batch(
                    db,
                    plan({
                        operationId: 'b',
                        baseVersion: { epoch: 'epoch-a', revision: 1 },
                        next: next(['b']),
                    }),
                    index
                )
            ).toThrow('malformed JSON');
            expect(snapshot(db)).toEqual(before);
            expect(count(db, 'model_receipts')).toBe(1);
            expect(count(db, 'model_gate')).toBe(0);
        }
    );

    it('lets only one independent connection commit the same revision', () => {
        const directory = mkdtempSync(join(tmpdir(), 'misub-atomic-model-'));
        paths.push(directory);
        const filename = join(directory, 'fixture.sqlite');
        const left = create(filename),
            right = open(filename);
        const a = plan(),
            b = plan({ operationId: 'b', next: next(['b']) });
        batch(left, a);
        expect(() => batch(right, b)).toThrow('model_revision_conflict');
        expect(snapshot(right)).toEqual(snapshot(left));
        expect(JSON.parse(snapshot(right).subscriptions).map((item) => item.id)).toEqual(['a']);
    });

    it.each([1, 2, 3, 4, 5, 6, 7])('cannot commit an unfinished gate after %i steps', (length) => {
        const db = create();
        expect(() => batch(db, plan().slice(0, length))).toThrow('FOREIGN KEY');
        expect(snapshot(db).revision).toBe(0);
        expect(count(db, 'model_gate')).toBe(0);
        expect(count(db, 'model_receipts')).toBe(0);
    });

    it('cannot close admission without the version and receipt', () => {
        const db = create(),
            steps = plan();
        expect(() => batch(db, [steps[0], ...steps.slice(1, 5), steps[7]])).toThrow(
            'model_incomplete_commit'
        );
        expect(count(db, 'model_subscriptions')).toBe(0);
    });

    it('replays the same operation after revision advanced without another write', () => {
        const db = create(),
            first = plan();
        const receipt = batch(db, first);
        batch(
            db,
            plan({
                operationId: 'b',
                baseVersion: { epoch: 'epoch-a', revision: 1 },
                next: next(['b']),
            })
        );
        const before = snapshot(db);
        expect(batch(db, first)).toEqual(receipt);
        expect(snapshot(db)).toEqual(before);
        expect(count(db, 'model_receipts')).toBe(2);
    });

    it('rejects an operation ID reused with a different payload', () => {
        const db = create();
        batch(db, plan());
        expect(() => batch(db, plan({ next: next(['b']) }))).toThrow('model_operation_conflict');
        expect(snapshot(db).revision).toBe(1);
    });

    it('rotates epoch with a restore candidate and rejects old history replays', () => {
        const db = create(),
            original = plan();
        batch(db, original);
        batch(
            db,
            plan({
                operationId: 'restore',
                baseVersion: { epoch: 'epoch-a', revision: 1 },
                nextEpoch: 'epoch-b',
                next: next(['restored']),
            })
        );
        expect(snapshot(db)).toMatchObject({ epoch: 'epoch-b', revision: 0 });
        expect(() => batch(db, original)).toThrow('model_epoch_conflict');
    });

    it.each([false, true])(
        'never reuses an epoch, including initialization (receipt: %s)',
        (withReceipt) => {
            const db = create(),
                oldRequest = plan({ operationId: 'delayed' });
            if (withReceipt) batch(db, plan());
            batch(
                db,
                plan({
                    operationId: 'restore-b',
                    baseVersion: { epoch: 'epoch-a', revision: withReceipt ? 1 : 0 },
                    nextEpoch: 'epoch-b',
                    next: next(['restored']),
                })
            );
            const before = snapshot(db);
            expect(() =>
                batch(
                    db,
                    plan({
                        operationId: 'restore-a',
                        baseVersion: { epoch: 'epoch-b', revision: 0 },
                        nextEpoch: 'epoch-a',
                    })
                )
            ).toThrow('model_epoch_reused');
            expect(() => batch(db, oldRequest)).toThrow('model_epoch_conflict');
            expect(snapshot(db)).toEqual(before);
            expect(count(db, 'model_epochs')).toBe(2);
        }
    );

    it('requires an explicitly requested restore epoch to differ from the current epoch', () => {
        expect(() => plan({ nextEpoch: 'epoch-a' })).toThrow('model_epoch_reused');
    });

    it('rolls back epoch allocation with a failed restore and permits a clean retry', () => {
        const db = create(),
            restore = plan({ nextEpoch: 'epoch-b' });
        expect(() => batch(db, restore, 7)).toThrow('malformed JSON');
        expect(snapshot(db).epoch).toBe('epoch-a');
        expect(count(db, 'model_epochs')).toBe(1);
        batch(db, restore);
        expect(snapshot(db)).toMatchObject({ epoch: 'epoch-b', revision: 0 });
        expect(count(db, 'model_epochs')).toBe(2);
    });

    it.each(['model_subscriptions', 'model_profiles'])(
        'rejects legacy writes to %s without a gate',
        (table) => {
            const db = create();
            batch(db, plan());
            const before = snapshot(db);
            for (const sql of [
                `INSERT OR REPLACE INTO ${table} VALUES('main','[]')`,
                `UPDATE ${table} SET data='[]'`,
                `DELETE FROM ${table}`,
            ])
                expect(() => db.exec(sql)).toThrow('model_unversioned_write');
            expect(snapshot(db)).toEqual(before);
        }
    );

    it('rejects metadata writes from outside the protocol', () => {
        const db = create();
        expect(() => db.exec('UPDATE model_meta SET revision=9')).toThrow(
            'model_unversioned_write'
        );
    });

    it('fails closed without initialization', () => {
        const db = open();
        MODEL_SCHEMA.forEach((sql) => db.exec(sql));
        expect(() => batch(db, plan())).toThrow('model_uninitialized');
        expect(count(db, 'model_subscriptions')).toBe(0);
    });

    it.each(['kv', 'noop', 'd1'])('does not claim runtime atomic capability for %s', (backend) => {
        expect(() => plan({ backend })).toThrow('model_atomic_backend_required');
    });

    it('requires a version and rejects invalid or dangling references before SQL', () => {
        expect(() => plan({ baseVersion: null })).toThrow('model_version_required');
        expect(() => plan({ next: next(['a', 'a']) })).toThrow('model_invalid_data');
        expect(() =>
            plan({
                next: { subscriptions: [], profiles: [{ id: 'g', subscriptions: ['missing'] }] },
            })
        ).toThrow('model_invalid_reference');
        expect(() =>
            plan({ next: { subscriptions: [{ id: 'a', url: 'x'.repeat(262144) }], profiles: [] } })
        ).toThrow('model_capacity');
    });

    it('has deterministic digests across JSON key ordering', () => {
        const db = create();
        const receipt = batch(db, plan());
        const reversed = {
            profiles: [{ subscriptions: ['a'], id: 'group' }],
            subscriptions: [{ url: 'https://fixture.invalid/a', name: 'a', id: 'a' }],
        };
        expect(batch(db, plan({ next: reversed }))).toEqual(receipt);
    });

    it('bounds receipt storage and still permits an acknowledged retry at capacity', () => {
        const db = create(),
            first = plan();
        batch(db, first);
        for (let index = 1; index < 128; index++) {
            batch(
                db,
                plan({
                    operationId: `op-${index}`,
                    baseVersion: { epoch: 'epoch-a', revision: index },
                })
            );
        }
        expect(() =>
            batch(
                db,
                plan({ operationId: 'full', baseVersion: { epoch: 'epoch-a', revision: 128 } })
            )
        ).toThrow('model_receipt_capacity');
        expect(() =>
            batch(
                db,
                plan({
                    operationId: 'restore-full',
                    baseVersion: { epoch: 'epoch-a', revision: 128 },
                    nextEpoch: 'epoch-b',
                })
            )
        ).toThrow('model_receipt_capacity');
        expect(batch(db, first)[0].revision).toBe(1);
        expect(snapshot(db).revision).toBe(128);
    });
});
