// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory } from '../../functions/storage-adapter.js';

const node = 'trojan://synthetic@example.com:443#Fixture';
let fixture;
let storage;
let handleNodeCountRequest;
let handleCronTrigger;
let generateCombinedNodeList;

beforeEach(async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(node))
    );
    ({ handleNodeCountRequest } = await import('../../functions/modules/handlers/node-handler.js'));
    ({ handleCronTrigger } = await import('../../functions/modules/notifications.js'));
    ({ generateCombinedNodeList } =
        await import('../../functions/services/subscription-service.js'));
    fixture = await createProtocolFixture({
        subscriptions: [
            {
                id: 'one',
                name: 'Original',
                url: 'https://source.example/sub',
                enabled: true,
            },
        ],
    });
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    fixture?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function refreshInput() {
    const snapshot = await storage.readSubscriptionSnapshot();
    return new Request('https://misub.invalid/api/node_count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            subscriptionId: 'one',
            operationId: 'fixture-runtime',
            baseVersion: snapshot.version,
        }),
    });
}
async function edit(operations) {
    const snapshot = await storage.readSubscriptionSnapshot();
    return storage.commitSubscriptionOperations({
        operationId: 'fixture-edit',
        baseVersion: snapshot.version,
        operations,
    });
}

describe('runtime writer entry points with real SQLite transactions', () => {
    it('adapter settings writes are visible through strict reads and the request-policy snapshot', async () => {
        for (const value of [true, false]) {
            await storage.put('worker_settings_v1', { builtinSkipCertVerify: value });
            expect(await storage.get('worker_settings_v1')).toEqual({
                builtinSkipCertVerify: value,
                storageType: 'd1',
            });
            expect((await storage.readSubscriptionSnapshot()).requestPolicy).toBe(value ? 1 : 0);
            expect(
                JSON.parse(
                    fixture.sql.prepare("SELECT value FROM settings WHERE key='main'").get().value
                )
            ).toEqual({ builtinSkipCertVerify: value });
        }
        expect(
            fixture.sql.prepare("SELECT value FROM settings WHERE key='worker_settings_v1'").get()
        ).toBeUndefined();
    });
    it.each([false, true])('rejects an in-flight TLS policy change from %s', async (initial) => {
        const writeSettings = (value) =>
            storage.put('worker_settings_v1', { builtinSkipCertVerify: value });
        await writeSettings(initial);
        const request = await refreshInput();
        fetch.mockImplementation(async (_request, options) => {
            expect(Boolean(options.cf?.insecureSkipVerify)).toBe(initial);
            await writeSettings(!initial);
            return new Response(node);
        });
        const response = await handleNodeCountRequest(request, fixture.env);
        expect(response.status).toBe(409);
        const snapshot = await storage.readSubscriptionSnapshot();
        expect(snapshot.version.revision).toBe(0);
        expect(snapshot.subscriptions[0].nodeCount).toBeUndefined();
    });
    it('SQL admission rejects policy changes after the helper has read its snapshot', async () => {
        const request = await refreshInput();
        const originalBatch = fixture.db.batch;
        fixture.db.batch = async (statements) => {
            await storage.put('worker_settings_v1', { builtinSkipCertVerify: true });
            return originalBatch(statements);
        };
        const response = await handleNodeCountRequest(request, fixture.env);
        expect(response.status).toBe(409);
        expect((await response.json()).reason).toBe('identity_conflict');
        expect(fixture.state.batches).toBe(1);
        const snapshot = await storage.readSubscriptionSnapshot();
        expect(snapshot.version.revision).toBe(0);
        expect(snapshot.subscriptions[0].nodeCount).toBeUndefined();
    });
    it('unrelated settings changes do not invalidate a captured network policy', async () => {
        const request = await refreshInput();
        fetch.mockImplementation(async () => {
            await storage.put('worker_settings_v1', {
                builtinSkipCertVerify: 'true',
                unrelated: 'synthetic',
            });
            return new Response(node);
        });
        const response = await handleNodeCountRequest(request, fixture.env);
        expect(response.status).toBe(200);
        expect((await storage.readSubscriptionSnapshot()).subscriptions[0].nodeCount).toBe(1);
    });
    it('commits a refresh without replacing a concurrently edited name', async () => {
        const request = await refreshInput();
        let edited = false;
        fetch.mockImplementation(async () => {
            if (!edited) {
                edited = true;
                await edit([
                    {
                        type: 'update',
                        collection: 'subscriptions',
                        id: 'one',
                        fields: { name: 'Edited' },
                    },
                ]);
            }
            return new Response(node);
        });
        const response = await handleNodeCountRequest(request, fixture.env);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ success: true, applied: true });
        const current = await storage.readSubscriptionSnapshot();
        expect(current.subscriptions[0]).toMatchObject({ name: 'Edited', nodeCount: 1 });
        expect(current.version.revision).toBe(2);
    });
    it.each(['remove', 'url', 'recreate'])(
        'rejects refresh after concurrent %s and preserves the committed edit',
        async (mutation) => {
            const request = await refreshInput();
            let edited = false;
            fetch.mockImplementation(async () => {
                if (!edited) {
                    edited = true;
                    const operations =
                        mutation === 'url'
                            ? [
                                  {
                                      type: 'update',
                                      collection: 'subscriptions',
                                      id: 'one',
                                      fields: { url: 'https://new.example/sub' },
                                  },
                              ]
                            : [{ type: 'remove', collection: 'subscriptions', ids: ['one'] }];
                    if (mutation === 'recreate')
                        operations.push({
                            type: 'create',
                            collection: 'subscriptions',
                            item: {
                                id: 'one',
                                name: 'Recreated',
                                enabled: true,
                                url: 'https://source.example/sub',
                            },
                        });
                    await edit(operations);
                }
                return new Response(node);
            });
            const response = await handleNodeCountRequest(request, fixture.env);
            expect(response.status).toBe(409);
            expect((await response.json()).applied).toBe(false);
            const current = await storage.readSubscriptionSnapshot();
            expect(current.version.revision).toBe(1);
            if (mutation === 'remove') expect(current.subscriptions).toEqual([]);
            else expect(current.subscriptions[0].nodeCount).toBeUndefined();
        }
    );
    it('SQL failure leaves the previous runtime state and revision intact', async () => {
        const request = await refreshInput();
        const before = await storage.readSubscriptionSnapshot();
        fixture.state.failAt = 4;
        const response = await handleNodeCountRequest(request, fixture.env);
        expect(response.status).toBe(503);
        expect(await storage.readSubscriptionSnapshot()).toEqual(before);
    });
    it('Cron does not resurrect a subscription removed during fetch', async () => {
        let removed = false;
        fetch.mockImplementation(async () => {
            if (!removed) {
                removed = true;
                await edit([{ type: 'remove', collection: 'subscriptions', ids: ['one'] }]);
            }
            return new Response(node);
        });
        const response = await handleCronTrigger(fixture.env);
        expect((await response.json()).summary).toMatchObject({ updated: 0, failed: 1 });
        expect((await storage.readSubscriptionSnapshot()).subscriptions).toEqual([]);
    });
    it('download waitUntil refuses a removed target', async () => {
        const snapshot = await storage.readSubscriptionSnapshot();
        const pending = [];
        fetch.mockImplementation(async () => {
            await edit([{ type: 'remove', collection: 'subscriptions', ids: ['one'] }]);
            return new Response(node);
        });
        const result = await generateCombinedNodeList(
            { storage, waitUntil: (value) => pending.push(value) },
            {},
            'ClashMeta',
            snapshot.subscriptions
        );
        await Promise.all(pending);
        expect(result).toContain('trojan://');
        expect((await storage.readSubscriptionSnapshot()).subscriptions).toEqual([]);
    });
});
