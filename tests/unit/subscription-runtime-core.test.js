// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory, SettingsCache, DataMigrator } from '../../functions/storage-adapter.js';
import {
    createSubscriptionProtocol,
    captureSubscriptionIdentity,
    commitRuntimeObservation,
} from '../../functions/services/subscription-protocol/index.js';
import { RECEIPT_TTL_MS } from '../../functions/services/subscription-protocol/sql.js';

const fixtures = [];
afterEach(() => {
    fixtures.splice(0).forEach((fixture) => fixture.close());
    SettingsCache.clear();
    vi.restoreAllMocks();
});
async function fixture(options = {}) {
    const result = await createProtocolFixture({
        subscriptions: [
            { id: 'a', name: 'original', url: 'https://fixture.invalid/a', enabled: true },
        ],
        profiles: [{ id: 'g', subscriptions: ['a'], manualNodes: [] }],
        ...options,
    });
    fixtures.push(result);
    result.storage = StorageFactory.createAdapter(result.env, 'd1');
    return result;
}
const edit = (operations, revision = 0, operationId = 'edit-one') => ({
    operationId,
    baseVersion: { epoch: 'fixture-epoch', revision },
    operations,
});
const rename = (name) => ({
    type: 'update',
    collection: 'subscriptions',
    id: 'a',
    fields: { name },
});
const rowCount = (sql, table) => sql.prepare(`SELECT count(*) n FROM ${table}`).get().n;

describe('gated subscription runtime protocol', () => {
    it('uses the existing D1 settings row for adapter writes, reads, cache and request policy', async () => {
        const { storage, env, sql } = await fixture();
        const settings = { builtinSkipCertVerify: true, marker: 'synthetic-settings' };
        await storage.commitDomainOperations({ ...edit([]), domains: { settings } });
        expect(
            sql
                .prepare('SELECT key FROM settings')
                .all()
                .map((row) => row.key)
        ).toEqual(['main']);
        expect(await storage.get('worker_settings_v1')).toEqual({ ...settings, storageType: 'd1' });
        expect(await SettingsCache.get(env)).toEqual({ ...settings, storageType: 'd1' });
        expect((await storage.readSubscriptionSnapshot()).requestPolicy).toBe(1);
    });

    it.each([undefined, null, false, 'true', 1, true])(
        'captures only the literal true TLS request policy: %s',
        async (builtinSkipCertVerify) => {
            const { storage } = await fixture({ settings: { builtinSkipCertVerify } });
            expect((await storage.readSubscriptionSnapshot()).requestPolicy).toBe(
                builtinSkipCertVerify === true ? 1 : 0
            );
        }
    );

    it('atomically rejects a request policy change between observation and the D1 batch', async () => {
        const { storage, sql, db } = await fixture();
        const before = await storage.readSubscriptionSnapshot();
        const originalBatch = db.batch.bind(db);
        db.batch = async (statements) => {
            db.batch = originalBatch;
            await storage.commitDomainOperations({
                ...edit([], 0, 'settings-race'),
                domains: { settings: { builtinSkipCertVerify: true } },
            });
            return originalBatch(statements);
        };
        expect(
            await commitRuntimeObservation(storage, {
                operationId: 'policy-race',
                id: 'a',
                identity: await captureSubscriptionIdentity(before.subscriptions[0]),
                epoch: 'fixture-epoch',
                requestPolicy: before.requestPolicy,
                observedAt: 10,
                fields: { nodeCount: 4 },
            })
        ).toEqual({ applied: false, reason: 'identity_conflict' });
        const after = await storage.readSubscriptionSnapshot();
        expect(after.version).toEqual({ ...before.version, revision: 1 });
        expect(after.subscriptions).toEqual(before.subscriptions);
        expect(after.requestPolicy).toBe(1);
        expect(rowCount(sql, 'subscription_protocol_gate')).toBe(0);
        expect(rowCount(sql, 'subscription_protocol_receipts')).toBe(1);
    });

    it('requires and digests request policy while allowing a committed receipt replay', async () => {
        const { storage } = await fixture();
        const snapshot = await storage.readSubscriptionSnapshot();
        const observation = {
            operationId: 'policy-replay',
            epoch: 'fixture-epoch',
            id: 'a',
            identity: await captureSubscriptionIdentity(snapshot.subscriptions[0]),
            observedAt: 10,
            fields: { nodeCount: 4 },
        };
        await expect(commitRuntimeObservation(storage, observation)).rejects.toThrow(
            'invalid_operation'
        );
        const committed = await commitRuntimeObservation(storage, {
            ...observation,
            epoch: 'fixture-epoch',
            requestPolicy: 0,
        });
        await storage.commitDomainOperations({
            ...edit([], 1, 'settings-replay'),
            domains: { settings: { builtinSkipCertVerify: true } },
        });
        const replay = await commitRuntimeObservation(storage, {
            ...observation,
            epoch: 'fixture-epoch',
            requestPolicy: 0,
        });
        expect(replay.replayed).toBe(true);
        expect(replay.receipt).toEqual(committed.receipt);
        await expect(
            commitRuntimeObservation(storage, { ...observation, requestPolicy: 1 })
        ).rejects.toThrow('operation_id_conflict');
    });

    it('keeps the default KV adapter behavior without claiming atomic capability', async () => {
        const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn() };
        const storage = StorageFactory.createAdapter({ MISUB_KV: kv }, 'kv');
        expect(storage.subscriptionProtocol).toBeUndefined();
        await storage.put('misub_subscriptions_v1', []);
        expect(kv.put).toHaveBeenCalledOnce();
    });

    it.each(['unknown', 'kv-strict', true])('fails closed for unknown explicit mode %s', (mode) => {
        const kv = { get: vi.fn(), put: vi.fn() };
        expect(() =>
            StorageFactory.createAdapter({ MISUB_KV: kv, MISUB_SUBSCRIPTION_PROTOCOL: mode })
        ).toThrow('invalid_protocol_mode');
        expect(kv.get).not.toHaveBeenCalled();
    });

    it('refuses KV-only strict configuration before fallback or migration', async () => {
        const kv = { get: vi.fn(), put: vi.fn() };
        const env = {
            MISUB_KV: kv,
            MISUB_SUBSCRIPTION_PROTOCOL: 'd1-v1',
            MISUB_SUBSCRIPTION_AUTHORITY: 'fixture-authority',
        };
        await expect(StorageFactory.getStorageType(env)).rejects.toThrow('atomic_backend_required');
        await expect(DataMigrator.migrateKVToD1(env)).rejects.toThrow('migration_required');
        expect(kv.get).not.toHaveBeenCalled();
    });

    it('pins authority before settings cache and refuses a mismatched initialized database', async () => {
        const { env } = await fixture({ settings: { storageType: 'kv', marker: 'fixture' } });
        expect(await StorageFactory.getStorageType(env)).toBe('d1');
        expect(await SettingsCache.get(env)).toMatchObject({
            storageType: 'd1',
            marker: 'fixture',
        });
        const wrong = StorageFactory.createAdapter(
            { ...env, MISUB_SUBSCRIPTION_AUTHORITY: 'different' },
            'd1'
        );
        await expect(wrong.getAllSubscriptions()).rejects.toThrow('authority_mismatch');
    });

    it('does not execute DDL when schema is missing', async () => {
        const { env, sql, state } = await fixture();
        sql.exec('DROP TABLE subscription_protocol_meta');
        const storage = StorageFactory.createAdapter(env, 'd1');
        await expect(storage.readSubscriptionSnapshot()).rejects.toThrow('schema_not_ready');
        expect(state.batches).toBe(0);
    });

    it('allows one of two same-baseline clients and rejects the other without overwriting', async () => {
        const { storage, env } = await fixture();
        const other = StorageFactory.createAdapter(env, 'd1');
        const results = await Promise.allSettled([
            storage.commitSubscriptionOperations(edit([rename('left')])),
            other.commitSubscriptionOperations(edit([rename('right')], 0, 'right')),
        ]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.find(({ status }) => status === 'rejected').reason.code).toBe(
            'revision_conflict'
        );
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(1);
    });

    it('replays a lost response after later edits and rejects a changed same-ID payload', async () => {
        const { storage } = await fixture();
        const request = edit([rename('first')]);
        const committed = await storage.commitSubscriptionOperations(request);
        await storage.commitSubscriptionOperations(edit([rename('second')], 1, 'second'));
        const retry = await storage.commitSubscriptionOperations(request);
        expect(retry.receipt).toEqual(committed.receipt);
        expect(retry.replayed).toBe(true);
        expect(retry.snapshot.subscriptions[0].name).toBe('second');
        await expect(
            storage.commitSubscriptionOperations(edit([rename('changed')]))
        ).rejects.toThrow('operation_id_conflict');
    });

    it('atomically deletes a subscription and both kinds of profile references', async () => {
        const { storage } = await fixture({
            profiles: [{ id: 'g', subscriptions: ['a'], manualNodes: ['a'] }],
        });
        const result = await storage.commitSubscriptionOperations(
            edit([{ type: 'remove', collection: 'subscriptions', ids: ['a'] }])
        );
        expect(result.snapshot.subscriptions).toEqual([]);
        expect(result.snapshot.profiles[0]).toMatchObject({ subscriptions: [], manualNodes: [] });
    });

    it.each(Array.from({ length: 10 }, (_, i) => i))(
        'rolls back every production-plan SQL boundary %i',
        async (index) => {
            const { storage, state, sql } = await fixture();
            const before = await storage.readSubscriptionSnapshot();
            state.failAt = index;
            await expect(
                storage.commitSubscriptionOperations(
                    edit([{ type: 'remove', collection: 'subscriptions', ids: ['a'] }])
                )
            ).rejects.toThrow();
            expect(await storage.readSubscriptionSnapshot()).toEqual(before);
            expect(rowCount(sql, 'subscription_protocol_receipts')).toBe(0);
            expect(rowCount(sql, 'subscription_protocol_gate')).toBe(0);
        }
    );

    it('refuses all legacy collection mutators and raw old main DML', async () => {
        const { storage, sql } = await fixture();
        const calls = [
            () => storage.put('misub_subscriptions_v1', []),
            () => storage.delete('misub_profiles_v1'),
            () => storage.putSubscription({ id: 'a' }),
            () => storage.putProfile({ id: 'g' }),
            () => storage.putAllSubscriptions([]),
            () => storage.putAllProfiles([]),
            () => storage.deleteSubscriptionById('a'),
            () => storage.deleteProfileById('g'),
            () => storage.updateSubscriptionById('a', () => ({ id: 'a' })),
        ];
        for (const call of calls) await expect(call()).rejects.toThrow('legacy_write_blocked');
        expect(() =>
            sql.exec("INSERT OR REPLACE INTO subscriptions(id,data) VALUES('main','[]')")
        ).toThrow('subscription_legacy_write_blocked');
        expect((await storage.readSubscriptionSnapshot()).subscriptions).toHaveLength(1);
    });

    it('requires explicit metadata and rejects editing runtime or incarnation fields', async () => {
        const { storage, state } = await fixture();
        await expect(storage.commitSubscriptionOperations({ operations: [] })).rejects.toThrow(
            'version_required'
        );
        for (const fields of [
            { nodeCount: 100 },
            { _writeGeneration: 'forged' },
            { sortIndex: 9 },
            { url: { bad: true } },
        ]) {
            await expect(
                storage.commitSubscriptionOperations(edit([{ ...rename('x'), fields }]))
            ).rejects.toThrow('invalid_operation');
        }
        expect(state.batches).toBe(0);
    });

    it('does not allow settings or old migration helpers to change authority', async () => {
        const { storage, env } = await fixture();
        await expect(storage.put('worker_settings_v1', { storageType: 'kv' })).rejects.toThrow(
            'legacy_write_blocked'
        );
        await expect(storage.delete('worker_settings_v1')).rejects.toThrow('legacy_write_blocked');
        await expect(
            storage.commitDomainOperations({
                ...edit([]),
                domains: { settings: { storageType: 'kv' } },
            })
        ).rejects.toThrow('authority_mismatch');
        await expect(DataMigrator.migrateLegacyD1MainRows(env)).rejects.toThrow(
            'migration_required'
        );
        await expect(StorageFactory.ensureD1Settings(env)).rejects.toThrow('migration_required');
    });

    it('expires receipts without allowing a stale edit to become a new write', async () => {
        const { env, sql } = await fixture();
        let clock = 1000;
        const storage = createSubscriptionProtocol(env, { now: () => clock });
        const request = edit([rename('first')]);
        await storage.commitSubscriptionOperations(request);
        clock += RECEIPT_TTL_MS + 1;
        await expect(storage.commitSubscriptionOperations(request)).rejects.toThrow(
            'revision_conflict'
        );
        await storage.commitSubscriptionOperations(edit([rename('new')], 1, 'new'));
        expect(rowCount(sql, 'subscription_protocol_receipts')).toBe(1);
    });

    it('rotates restoration history and rejects old requests or historical epoch reuse', async () => {
        const { storage } = await fixture();
        const before = await storage.readSubscriptionSnapshot();
        const result = await storage.restoreSubscriptionSnapshot({
            ...edit([], 0, 'restore'),
            nextEpoch: 'next-epoch',
            subscriptions: before.subscriptions,
            profiles: before.profiles,
        });
        expect(result.snapshot.version).toEqual({ epoch: 'next-epoch', revision: 0 });
        expect(result.snapshot.subscriptions[0]._writeGeneration).not.toBe(
            before.subscriptions[0]._writeGeneration
        );
        await expect(storage.commitSubscriptionOperations(edit([rename('old')]))).rejects.toThrow(
            'epoch_conflict'
        );
        await expect(
            storage.restoreSubscriptionSnapshot({
                operationId: 'restore-again',
                baseVersion: result.snapshot.version,
                nextEpoch: 'fixture-epoch',
                subscriptions: [],
                profiles: [],
            })
        ).rejects.toThrow('epoch_conflict');
    });

    it('binds runtime results to incarnation and URL, preserving concurrent user fields', async () => {
        const { storage } = await fixture();
        const original = (await storage.readSubscriptionSnapshot()).subscriptions[0];
        const observation = {
            operationId: 'observation',
            id: 'a',
            identity: await captureSubscriptionIdentity(original),
            epoch: 'fixture-epoch',
            requestPolicy: 0,
            observedAt: 10,
            fields: { nodeCount: 4 },
        };
        await storage.commitSubscriptionOperations(edit([rename('user-name')]));
        const result = await commitRuntimeObservation(storage, observation);
        expect(result.applied).toBe(true);
        expect(result.snapshot.subscriptions[0]).toMatchObject({ name: 'user-name', nodeCount: 4 });
        const replay = await commitRuntimeObservation(storage, observation);
        expect(replay.replayed).toBe(true);
        expect(replay.receipt).toEqual(result.receipt);
        await storage.commitSubscriptionOperations(
            edit(
                [{ ...rename('unused'), fields: { url: 'https://fixture.invalid/new' } }],
                2,
                'url'
            )
        );
        expect(
            await commitRuntimeObservation(storage, {
                ...observation,
                operationId: 'old-url',
                epoch: 'fixture-epoch',
                requestPolicy: 0,
                observedAt: 20,
            })
        ).toMatchObject({ applied: false, reason: 'identity_conflict' });
    });

    it('does not resurrect deleted or recreated IDs after background completion', async () => {
        const { storage } = await fixture();
        const original = (await storage.readSubscriptionSnapshot()).subscriptions[0];
        const observation = {
            operationId: 'delayed',
            id: 'a',
            identity: await captureSubscriptionIdentity(original),
            epoch: 'fixture-epoch',
            requestPolicy: 0,
            observedAt: 10,
            fields: { nodeCount: 4 },
        };
        await storage.commitSubscriptionOperations(
            edit([{ type: 'remove', collection: 'subscriptions', ids: ['a'] }])
        );
        expect(await commitRuntimeObservation(storage, observation)).toMatchObject({
            applied: false,
            reason: 'unknown_item',
        });
        await storage.commitSubscriptionOperations(
            edit(
                [
                    {
                        type: 'create',
                        collection: 'subscriptions',
                        item: { id: 'a', name: 'new', url: original.url, enabled: true },
                    },
                ],
                1,
                'recreate'
            )
        );
        expect(await commitRuntimeObservation(storage, observation)).toMatchObject({
            applied: false,
            reason: 'identity_conflict',
        });
    });

    it('rejects stale runtime fields while permitting a different field at the same observation time', async () => {
        const { storage } = await fixture();
        const identity = await captureSubscriptionIdentity(
            (await storage.readSubscriptionSnapshot()).subscriptions[0]
        );
        await commitRuntimeObservation(storage, {
            operationId: 'new',
            id: 'a',
            identity,
            epoch: 'fixture-epoch',
            requestPolicy: 0,
            observedAt: 20,
            fields: { nodeCount: 8 },
        });
        expect(
            await commitRuntimeObservation(storage, {
                operationId: 'old',
                id: 'a',
                identity,
                epoch: 'fixture-epoch',
                requestPolicy: 0,
                observedAt: 10,
                fields: { nodeCount: 1 },
            })
        ).toMatchObject({ applied: false, reason: 'observation_stale' });
        const result = await commitRuntimeObservation(storage, {
            operationId: 'traffic',
            id: 'a',
            identity,
            epoch: 'fixture-epoch',
            requestPolicy: 0,
            observedAt: 20,
            fields: { userInfo: { total: 100 } },
        });
        expect(result.applied).toBe(true);
        expect(result.snapshot.subscriptions[0]).toMatchObject({
            nodeCount: 8,
            userInfo: { total: 100 },
        });
    });
});
