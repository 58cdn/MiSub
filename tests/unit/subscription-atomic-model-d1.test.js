// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
    MODEL_SCHEMA,
    MODEL_READ,
    compileSnapshotCommit,
} from '../../experiments/subscription-transactions/model.js';

const fixtures = [];
afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.runtime.dispose();
        expect(fixture.outbound).toEqual([]);
    }
});
async function create() {
    const fixture = { outbound: [] };
    fixture.runtime = new Miniflare({
        modules: true,
        compatibilityDate: '2025-08-01',
        script: 'export default { fetch() { return new Response("local fixture"); } };',
        d1Databases: { DB: 'subscription-atomic-model' },
        d1Persist: false,
        host: '127.0.0.1',
        port: 0,
        outboundService(request) {
            fixture.outbound.push(new URL(request.url).origin);
            return new Response('outbound forbidden', { status: 403 });
        },
    });
    fixtures.push(fixture);
    const db = await fixture.runtime.getD1Database('DB');
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
    for (const sql of MODEL_SCHEMA) await db.prepare(sql).run();
    await db.prepare("INSERT INTO model_meta VALUES(1,'epoch-a',0)").run();
    return db;
}
const plan = (operationId, revision = 0, id = operationId) =>
    compileSnapshotCommit({
        backend: 'd1-model',
        operationId,
        baseVersion: { epoch: 'epoch-a', revision },
        next: { subscriptions: [{ id }], profiles: [{ id: 'g', subscriptions: [id] }] },
    });
const execute = (db, steps) =>
    db.batch(steps.map(({ sql, args }) => db.prepare(sql).bind(...args)));

describe('local Miniflare D1 batch protocol model', () => {
    it('serializes competing batches with one winner and one version conflict', async () => {
        const db = await create();
        const results = await Promise.allSettled([execute(db, plan('a')), execute(db, plan('b'))]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(String(results.find((result) => result.status === 'rejected').reason)).toContain(
            'model_revision_conflict'
        );
        const state = await db.prepare(MODEL_READ).first();
        expect(state.revision).toBe(1);
        expect(JSON.parse(state.subscriptions)).toHaveLength(1);
        expect(await db.prepare('SELECT count(*) n FROM model_gate').first('n')).toBe(0);
    });

    it('rolls back real SQL failures at every batch boundary', async () => {
        const db = await create();
        await execute(db, plan('a'));
        const before = await db.prepare(MODEL_READ).first();
        for (let index = 0; index < 9; index++) {
            const steps = plan('b', 1);
            steps.splice(index, 0, { sql: "SELECT json('invalid-fixture-json')", args: [] });
            await expect(execute(db, steps)).rejects.toThrow();
            expect(await db.prepare(MODEL_READ).first()).toEqual(before);
            expect(await db.prepare('SELECT count(*) n FROM model_receipts').first('n')).toBe(1);
            expect(await db.prepare('SELECT count(*) n FROM model_gate').first('n')).toBe(0);
        }
    });

    it('replays after a lost response, rejects collisions and blocks legacy writers', async () => {
        const db = await create();
        const original = plan('a');
        const first = await execute(db, original);
        await execute(db, plan('b', 1));
        expect((await execute(db, original)).at(-1).results).toEqual(first.at(-1).results);
        expect((await db.prepare(MODEL_READ).first()).revision).toBe(2);
        await expect(execute(db, plan('a', 0, 'changed'))).rejects.toThrow(
            'model_operation_conflict'
        );
        await expect(
            db.prepare("INSERT OR REPLACE INTO model_subscriptions VALUES('main','[]')").run()
        ).rejects.toThrow('model_unversioned_write');
    });

    it('does not persist an admission gate from an incomplete batch or standalone run', async () => {
        const db = await create(),
            steps = plan('a');
        await expect(execute(db, steps.slice(0, 7))).rejects.toThrow('FOREIGN KEY');
        await expect(execute(db, [steps[0], ...steps.slice(1, 5), steps[7]])).rejects.toThrow(
            'model_incomplete_commit'
        );
        await expect(
            db
                .prepare(steps[0].sql)
                .bind(...steps[0].args)
                .run()
        ).rejects.toThrow('FOREIGN KEY');
        expect(await db.prepare('SELECT count(*) n FROM model_gate').first('n')).toBe(0);
        expect((await db.prepare(MODEL_READ).first()).revision).toBe(0);
    });

    it('never permits historical epoch reuse or delayed writes after restoration', async () => {
        const db = await create(),
            delayed = plan('delayed');
        const restore = (epoch, nextEpoch) =>
            compileSnapshotCommit({
                backend: 'd1-model',
                baseVersion: { epoch, revision: 0 },
                operationId: `restore-${nextEpoch}`,
                nextEpoch,
                next: { subscriptions: [], profiles: [] },
            });
        const failed = restore('epoch-a', 'epoch-b');
        failed.splice(7, 0, { sql: "SELECT json('invalid-fixture-json')", args: [] });
        await expect(execute(db, failed)).rejects.toThrow();
        expect(await db.prepare('SELECT count(*) n FROM model_epochs').first('n')).toBe(1);
        await execute(db, restore('epoch-a', 'epoch-b'));
        const before = await db.prepare(MODEL_READ).first();
        await expect(execute(db, restore('epoch-b', 'epoch-a'))).rejects.toThrow(
            'model_epoch_reused'
        );
        await expect(execute(db, delayed)).rejects.toThrow('model_epoch_conflict');
        expect(await db.prepare(MODEL_READ).first()).toEqual(before);
        expect(await db.prepare('SELECT count(*) n FROM model_epochs').first('n')).toBe(2);
    });
});
