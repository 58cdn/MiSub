// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory, SettingsCache } from '../../functions/storage-adapter.js';
import { handleExternalSubscriptionsRequest } from '../../functions/modules/external-subscriptions-handler.js';
import { handleExternalManualNodesRequest } from '../../functions/modules/external-manual-nodes-handler.js';
import { isManualNode, isRemoteSubscription } from '../../shared/subscription-kind.js';
import { handleNodeCountRequest } from '../../functions/modules/handlers/node-handler.js';
import {
    normalizeBackupPayload,
    restoreBackupPayload,
} from '../../functions/modules/webdav-backup-handler.js';
import {
    captureSubscriptionIdentity,
    commitRuntimeObservation,
} from '../../functions/services/subscription-protocol/index.js';

const rootUrl = 'https://fixture:fixture@source.example.invalid:443/';
const fixtures = [];
afterEach(() => {
    fixtures.splice(0).forEach((fixture) => fixture.close());
    SettingsCache.clear();
    vi.unstubAllGlobals();
});
const request = (body, method = 'POST') =>
    new Request('https://fixture.invalid/api/ext/v1/test', {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

async function setup(mode) {
    if (mode === 'd1-v1') {
        const fixture = await createProtocolFixture({ subscriptions: [], profiles: [] });
        fixtures.push(fixture);
        return { env: fixture.env, storage: StorageFactory.createAdapter(fixture.env, 'd1') };
    }
    const values = new Map([['misub_subscriptions_v1', '[]']]);
    const env = {
        MISUB_KV: {
            get: async (key) => values.get(key) ?? null,
            put: async (key, value) => values.set(key, value),
            delete: async (key) => values.delete(key),
        },
    };
    return { env, storage: StorageFactory.createAdapter(env, 'kv') };
}

describe.each(['legacy', 'd1-v1'])('explicit entry types through %s storage', (mode) => {
    it('retains endpoint intent across create, reload and URL edits for the same Basic Auth URL', async () => {
        const { env, storage } = await setup(mode);
        const metadata = async (id, operationId) =>
            mode === 'd1-v1'
                ? {
                      id,
                      operationId,
                      baseVersion: (await storage.readSubscriptionSnapshot()).version,
                  }
                : {};
        const created = [];
        for (const [type, handler] of [
            ['subscription', handleExternalSubscriptionsRequest],
            ['manual_node', handleExternalManualNodesRequest],
        ]) {
            const response = await handler(
                request({ ...(await metadata(type, `create_${type}`)), name: type, url: rootUrl }),
                env
            );
            expect(response.status).toBe(201);
            created.push({ type, id: (await response.json()).data.id, handler });
        }
        const reloaded = await storage.getAllSubscriptions();
        expect(reloaded.filter(isRemoteSubscription).map((item) => item.type)).toEqual([
            'subscription',
        ]);
        expect(reloaded.filter(isManualNode).map((item) => item.type)).toEqual(['manual_node']);
        for (const { id, type, handler } of created) {
            const response = await handler(
                request(
                    {
                        ...(await metadata(id, `update_${type}`)),
                        url: `${rootUrl}?sni=tls.example.invalid`,
                    },
                    'PATCH'
                ),
                env,
                id
            );
            expect(response.status).toBe(200);
            expect((await response.json()).data.type).toBe(type);
        }
        const after = await storage.getAllSubscriptions();
        expect(after.find(isRemoteSubscription)).toMatchObject({ type: 'subscription' });
        expect(after.find(isManualNode)).toMatchObject({ type: 'manual_node' });
    });
});

describe('entry type and runtime observations', () => {
    it('preserves an explicit manualNodes backup collection through legacy normalization and atomic restore', async () => {
        const backup = {
            subscriptions: [{ id: 'source', url: rootUrl }],
            manualNodes: [{ id: 'proxy', url: rootUrl }],
            profiles: [{ id: 'profile', subscriptions: ['source'], manualNodes: ['proxy'] }],
        };
        const normalized = normalizeBackupPayload(backup).data.subscriptions;
        expect(normalized.find(isManualNode)).toMatchObject({ id: 'proxy', type: 'manual_node' });
        expect(normalized.find(isRemoteSubscription)).toMatchObject({ id: 'source' });
        expect(backup.manualNodes[0]).not.toHaveProperty('type');
        const fixture = await createProtocolFixture({ subscriptions: [], profiles: [] });
        fixtures.push(fixture);
        const storage = StorageFactory.createAdapter(fixture.env, 'd1');
        await restoreBackupPayload(fixture.env, backup, {
            operationId: 'restore_typed',
            baseVersion: (await storage.readSubscriptionSnapshot()).version,
            nextEpoch: 'restored_type_epoch',
        });
        const restored = (await storage.readSubscriptionSnapshot()).subscriptions;
        expect(restored.find(isManualNode)).toMatchObject({ id: 'proxy', type: 'manual_node' });
        expect(restored.find(isRemoteSubscription)).toMatchObject({ id: 'source' });
    });
    it('uses stored manual-node intent before fetching despite a caller-supplied subscription type', async () => {
        const fixture = await createProtocolFixture({
            subscriptions: [{ id: 'entry', url: rootUrl, type: 'manual_node', enabled: true }],
            profiles: [],
        });
        fixtures.push(fixture);
        const storage = StorageFactory.createAdapter(fixture.env, 'd1');
        vi.stubGlobal('fetch', vi.fn());
        const response = await handleNodeCountRequest(
            request({
                subscriptionId: 'entry',
                operationId: 'attempt_refresh',
                baseVersion: (await storage.readSubscriptionSnapshot()).version,
                type: 'subscription',
                url: rootUrl,
            }),
            fixture.env
        );
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it('rejects stale observations after explicit intent changes without changing URL', async () => {
        const fixture = await createProtocolFixture({
            subscriptions: [{ id: 'entry', url: rootUrl, type: 'subscription', enabled: true }],
            profiles: [],
        });
        fixtures.push(fixture);
        const storage = StorageFactory.createAdapter(fixture.env, 'd1');
        const before = await storage.readSubscriptionSnapshot();
        const identity = await captureSubscriptionIdentity(before.subscriptions[0]);
        await storage.commitSubscriptionOperations({
            operationId: 'change_type',
            baseVersion: before.version,
            operations: [
                {
                    type: 'update',
                    collection: 'subscriptions',
                    id: 'entry',
                    fields: { type: 'manual_node' },
                },
            ],
        });
        const result = await commitRuntimeObservation(storage, {
            operationId: 'stale_observation',
            epoch: before.version.epoch,
            id: 'entry',
            identity,
            observedAt: Date.now(),
            requestPolicy: before.requestPolicy,
            fields: { nodeCount: 99 },
        });
        expect(result).toMatchObject({ applied: false, reason: 'identity_conflict' });
        expect((await storage.readSubscriptionSnapshot()).subscriptions[0]).toMatchObject({
            type: 'manual_node',
        });
    });
});
