// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
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
        authority: 'fixture-authority',
        epoch: 'fixture-epoch',
        ...overrides,
    });
async function create() {
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
    for (const table of ['subscriptions', 'profiles'])
        await db
            .prepare(
                `CREATE TABLE ${table}(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT,updated_at TEXT)`
            )
            .run();
    await db
        .prepare('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)')
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
        const { db, env } = await create();
        const source = [{ id: 'main', data: JSON.stringify([item]) }];
        await db
            .prepare('INSERT INTO subscriptions(id,data) VALUES(?,?)')
            .bind('main', source[0].data)
            .run();
        await db
            .prepare('INSERT INTO profiles(id,data) VALUES(?,?)')
            .bind('g', JSON.stringify(group))
            .run();
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
