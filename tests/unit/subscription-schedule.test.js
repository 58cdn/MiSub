// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { createSignedToken } from '../../functions/modules/auth-middleware.js';
import { COOKIE_NAME } from '../../functions/modules/config.js';

const node = 'trojan://synthetic@example.com:443#Fixture';
let fixture;
let storage;
let schedule;
let cron;
let normalize;
beforeEach(async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (request) => {
            expect(new URL(request.url).hostname).toBe('source.example');
            return new Response(node);
        })
    );
    schedule = await import('../../functions/_schedule.js');
    cron = await import('../../functions/_cron.js');
    ({ normalizeSubscriptionSyncConfig: normalize } =
        await import('../../functions/modules/notifications.js'));
    fixture = await createProtocolFixture({
        settings: { cronSecret: 'fixture-cron-secret', NotifyThresholdPercent: 90 },
        subscriptions: [
            ...Array.from({ length: 4 }, (_, index) => ({
                id: `source-${index}`,
                name: `Source ${index}`,
                enabled: true,
                url: `https://source.example/${index}`,
            })),
            { id: 'disabled', enabled: false, url: 'https://source.example/disabled' },
            { id: 'manual', enabled: true, url: node },
        ],
    });
    fixture.env.COOKIE_SECRET = 'synthetic-test-cookie-key';
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
    for (const method of ['log', 'warn', 'error', 'info'])
        vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
    fixture?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
function http(path, headers = {}, method = 'GET') {
    return {
        request: new Request(`https://misub.invalid/${path}`, { method, headers }),
        env: fixture.env,
    };
}
async function adminCookie() {
    const token = await createSignedToken(fixture.env.COOKIE_SECRET, String(Date.now()));
    return `${COOKIE_NAME}=${encodeURIComponent(token)}`;
}

describe('scheduled HTTP authentication', () => {
    it.each(['_schedule', '_cron'])('rejects a forged CF-Cron header on %s', async (path) => {
        const entry = path === '_cron' ? cron : schedule;
        const response = await entry.onRequest(http(path, { 'CF-Cron': 'true' }));
        expect(response.status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it.each(['Bearer', 'query'])(
        'accepts an explicitly configured cron secret via %s',
        async (mode) => {
            const response = await schedule.onRequest(
                http(
                    mode === 'query' ? '_schedule?secret=fixture-cron-secret' : '_schedule',
                    mode === 'Bearer' ? { Authorization: 'Bearer fixture-cron-secret' } : {}
                )
            );
            expect(response.status).toBe(200);
            expect((await response.json()).subscriptionSync.successfulSyncs).toBe(4);
        }
    );
    it.each(['', 'wrong'])('rejects an incorrect or empty cron secret: %s', async (secret) => {
        expect((await schedule.onRequest(http(`_schedule?secret=${secret}`))).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('accepts a real signed admin cookie only for POST', async () => {
        const Cookie = await adminCookie();
        expect((await schedule.onRequest(http('_schedule', { Cookie }))).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
        const response = await schedule.onRequest(http('_schedule', { Cookie }, 'POST'));
        expect(response.status).toBe(200);
        expect((await response.json()).subscriptionSync.successfulSyncs).toBe(4);
    });
    it('rejects unsupported methods before storage reads or network', async () => {
        const spy = vi.spyOn(StorageFactory, 'createAdapter');
        const response = await schedule.onRequest(http('_schedule', {}, 'DELETE'));
        expect(response.status).toBe(405);
        expect(spy).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('rejects unknown task types after authentication without fetching', async () => {
        const response = await cron.onRequest(
            http(
                '_cron',
                {
                    Cookie: await adminCookie(),
                    'CF-Cron-Type': 'unknown',
                },
                'POST'
            )
        );
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('fails closed when the configured storage authority is missing', async () => {
        delete fixture.env.MISUB_SUBSCRIPTION_AUTHORITY;
        const response = await schedule.onRequest(http('_schedule?secret=fixture-cron-secret'));
        expect(response.status).toBe(503);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('does not let a signed cookie bypass disabled scheduling', async () => {
        fixture.env.ENABLE_CRON = 'false';
        const response = await schedule.onRequest(
            http('_schedule', { Cookie: await adminCookie() }, 'POST')
        );
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('canonical scheduled runtime observations', () => {
    it('caps eligible sources and commits runtime through the actual SQL protocol', async () => {
        const poison = {
            get: vi.fn(() => {
                throw new Error('raw binding');
            }),
            prepare: vi.fn(() => {
                throw new Error('raw binding');
            }),
        };
        const result = await schedule.performSubscriptionSync(
            { ...fixture.env, DB: poison, KV_STORAGE: poison },
            {
                maxSyncCount: 2,
                concurrency: 1,
                timeout: 1000,
            }
        );
        expect(result).toMatchObject({ totalSubscriptions: 2, successfulSyncs: 2, failedSyncs: 0 });
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(poison.get).not.toHaveBeenCalled();
        expect(poison.prepare).not.toHaveBeenCalled();
        const snapshot = await storage.readSubscriptionSnapshot();
        expect(snapshot.version.revision).toBe(2);
        expect(snapshot.subscriptions.filter((sub) => sub.nodeCount === 1)).toHaveLength(2);
        expect(
            snapshot.subscriptions.find((sub) => sub.id === 'disabled').nodeCount
        ).toBeUndefined();
    });
    it('supports zero work and rejects invalid limits without fetching', async () => {
        expect(
            (await schedule.performSubscriptionSync(fixture.env, { maxSyncCount: 0 }))
                .totalSubscriptions
        ).toBe(0);
        for (const config of [
            { maxSyncCount: -1 },
            { maxSyncCount: 1001 },
            { concurrency: 7 },
            { timeout: 0 },
            { timeout: 60001 },
        ]) {
            await expect(
                schedule.performSubscriptionSync(fixture.env, config)
            ).rejects.toMatchObject({ status: 400 });
        }
        expect(fetch).not.toHaveBeenCalled();
    });
    it('normalizes API aliases and bounded numeric strings', () => {
        expect(normalize({ syncTimeout: '250', enableParallel: false, maxSyncCount: '3' })).toEqual(
            { timeout: 250, concurrency: 1, maxSyncCount: 3 }
        );
    });
    it('limits simultaneous sources, including both fetches for each source', async () => {
        let active = 0;
        let peak = 0;
        fetch.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return new Response(node);
        });
        const result = await schedule.performSubscriptionSync(fixture.env, { concurrency: 2 });
        expect(result.successfulSyncs).toBe(4);
        expect(peak).toBe(4);
        expect(active).toBe(0);
    });
    it('aborts timed-out requests, drains both fetches and never commits them', async () => {
        let active = 0;
        fetch.mockImplementation(
            (request) =>
                new Promise((_, reject) => {
                    active++;
                    const abort = () => {
                        active--;
                        reject(new DOMException('Fixture timeout', 'AbortError'));
                    };
                    if (request.signal.aborted) abort();
                    else request.signal.addEventListener('abort', abort, { once: true });
                })
        );
        const result = await schedule.performSubscriptionSync(fixture.env, {
            maxSyncCount: 2,
            timeout: 10,
            concurrency: 1,
        });
        expect(result).toMatchObject({ successfulSyncs: 0, failedSyncs: 2 });
        expect(result.details.every((item) => item.error === 'timeout')).toBe(true);
        expect(active).toBe(0);
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it('keeps the internal request deadline independent of HTTP timeout fields', async () => {
        const { handleNodeCountRequest } =
            await import('../../functions/modules/handlers/node-handler.js');
        fetch.mockImplementation(
            (request) =>
                new Promise((_, reject) => {
                    request.signal.addEventListener(
                        'abort',
                        () => reject(new DOMException('Fixture deadline', 'AbortError')),
                        { once: true }
                    );
                })
        );
        const response = await handleNodeCountRequest(
            new Request('https://misub.invalid/api/node_count', {
                method: 'POST',
                body: JSON.stringify({
                    url: 'https://source.example/0',
                    inspectOnly: true,
                    timeoutMs: 60000,
                }),
            }),
            fixture.env,
            { timeoutMs: 5, requestPolicy: 0 }
        );
        expect(await response.json()).toMatchObject({ success: false, errorType: 'timeout' });
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it('propagates caller cancellation to both fetches without writing', async () => {
        const { handleNodeCountRequest } =
            await import('../../functions/modules/handlers/node-handler.js');
        const controller = new AbortController();
        let active = 0;
        fetch.mockImplementation(
            (request) =>
                new Promise((_, reject) => {
                    active++;
                    request.signal.addEventListener(
                        'abort',
                        () => {
                            active--;
                            reject(new DOMException('Fixture cancel', 'AbortError'));
                        },
                        { once: true }
                    );
                    if (active === 2) queueMicrotask(() => controller.abort());
                })
        );
        const response = await handleNodeCountRequest(
            new Request('https://misub.invalid/api/node_count', {
                method: 'POST',
                body: JSON.stringify({ url: 'https://source.example/0', inspectOnly: true }),
            }),
            fixture.env,
            { signal: controller.signal, requestPolicy: 0 }
        );
        expect(await response.json()).toMatchObject({ success: false, errorType: 'timeout' });
        expect(active).toBe(0);
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it('fills the maximum parallel batch without exhausting its own revision retries', async () => {
        const snapshot = await storage.readSubscriptionSnapshot();
        await storage.commitSubscriptionOperations({
            operationId: 'fixture-add-sources',
            baseVersion: snapshot.version,
            operations: [4, 5].map((id) => ({
                type: 'create',
                collection: 'subscriptions',
                item: {
                    id: `source-${id}`,
                    enabled: true,
                    url: `https://source.example/${id}`,
                },
            })),
        });
        const result = await schedule.performSubscriptionSync(fixture.env, { concurrency: 6 });
        expect(result).toMatchObject({ successfulSyncs: 6, failedSyncs: 0, totalSubscriptions: 6 });
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(7);
    });
    it('does not resurrect a source removed while fetching', async () => {
        let changed = false;
        fetch.mockImplementation(async () => {
            if (!changed) {
                changed = true;
                const snapshot = await storage.readSubscriptionSnapshot();
                await storage.commitSubscriptionOperations({
                    operationId: 'fixture-remove',
                    baseVersion: snapshot.version,
                    operations: [
                        { type: 'remove', collection: 'subscriptions', ids: ['source-0'] },
                    ],
                });
            }
            return new Response(node);
        });
        const result = await schedule.performSubscriptionSync(fixture.env, { maxSyncCount: 1 });
        expect(result).toMatchObject({ successfulSyncs: 0, failedSyncs: 1 });
        expect(
            (await storage.readSubscriptionSnapshot()).subscriptions.some(
                (sub) => sub.id === 'source-0'
            )
        ).toBe(false);
    });
    it('surfaces SQL failures without reporting successful updates', async () => {
        fixture.state.failAt = 3;
        await expect(
            schedule.performSubscriptionSync(fixture.env, { maxSyncCount: 1 })
        ).rejects.toMatchObject({ code: 'storage_unavailable' });
        expect((await storage.readSubscriptionSnapshot()).version.revision).toBe(0);
    });
    it('runs a directly invoked platform event independently of HTTP headers', async () => {
        const waitUntil = vi.fn();
        const result = await schedule.scheduled(
            {},
            { ...fixture.env, CRON_MAX_SYNC_COUNT: '1' },
            { waitUntil }
        );
        expect(result.successfulSyncs).toBe(1);
        expect(waitUntil).toHaveBeenCalledTimes(1);
    });
    it('keeps the daily summary explicit about bounded refresh scope', async () => {
        const response = await cron.onRequest(
            http(
                '_cron',
                { Cookie: await adminCookie(), 'CF-Cron-Type': 'daily-full-sync' },
                'POST'
            )
        );
        expect(await response.json()).toMatchObject({
            type: 'full-sync',
            scope: 'bounded-subscription-refresh',
            successfulSyncs: 4,
        });
    });
    it('reports measured traffic warnings and unavailable sources separately', async () => {
        fetch.mockImplementation(
            async (request) =>
                new Response(node, {
                    headers: request.url.endsWith('/0')
                        ? { 'subscription-userinfo': 'upload=9; download=1; total=10' }
                        : {},
                })
        );
        const response = await cron.onRequest(
            http('_cron', { Cookie: await adminCookie(), 'CF-Cron-Type': 'traffic-check' }, 'POST')
        );
        expect(await response.json()).toMatchObject({
            checkedSubscriptions: 1,
            unavailableSubscriptions: 3,
            warnings: 1,
        });
        expect(
            fetch.mock.calls.every(([req]) => new URL(req.url).hostname === 'source.example')
        ).toBe(true);
    });
    it('legacy mode writes through the main adapter without a raw binding shortcut', async () => {
        const sub = { id: 'legacy', enabled: true, url: 'https://source.example/legacy' };
        const legacy = {
            getAllSubscriptions: vi.fn(async () => [sub]),
            get: vi.fn(async () => ({})),
            updateSubscriptionById: vi.fn(async (_id, update) =>
                update({ ...sub, name: 'Current' })
            ),
        };
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('kv');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(legacy);
        const result = await schedule.performSubscriptionSync({});
        expect(result.successfulSyncs).toBe(1);
        expect(legacy.updateSubscriptionById).toHaveBeenCalledWith('legacy', expect.any(Function));
        expect(result.details[0].name).toBe('Current');
    });
});
