// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory } from '../../functions/storage-adapter.js';

const nodes = [
    'trojan://synthetic@example.com:443#Keep',
    'trojan://synthetic@other.example.com:443#Drop',
];
let fixture;
let storage;
let generate;
let cacheKey;
beforeEach(async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (request) => {
            expect(new URL(request.url).hostname).toBe('source.example');
            return new Response(nodes.join('\n'), {
                headers: { 'subscription-userinfo': 'upload=9; download=1; total=10' },
            });
        })
    );
    ({ generateCombinedNodeList: generate, buildSubscriptionNodeCacheKey: cacheKey } =
        await import('../../functions/services/subscription-service.js'));
    fixture = await createProtocolFixture({
        subscriptions: [
            {
                id: 'one',
                name: 'Original',
                enabled: true,
                url: 'https://source.example/sub',
                userInfo: { upload: 1, download: 0, total: 100 },
            },
        ],
    });
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
    for (const method of ['log', 'warn', 'error', 'info'])
        vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
    fixture?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
async function edit(fields) {
    const snapshot = await storage.readSubscriptionSnapshot();
    return storage.commitSubscriptionOperations({
        operationId: crypto.randomUUID(),
        baseVersion: snapshot.version,
        operations: [{ type: 'update', collection: 'subscriptions', id: 'one', fields }],
    });
}
async function settings(value) {
    const snapshot = await storage.readDomainSnapshot();
    return storage.commitDomainOperations({
        operationId: crypto.randomUUID(),
        baseVersion: snapshot.version,
        domains: { settings: value },
    });
}
async function download({
    config = {},
    profile = {},
    userAgent = 'ClashMeta',
    skipCertVerify = false,
    suppliedSources,
} = {}) {
    const snapshot = await storage.readSubscriptionSnapshot();
    const pending = [];
    const context = {
        storage,
        subscriptionSnapshot: snapshot,
        waitUntil: (task) => pending.push(task),
    };
    const output = await generate(
        context,
        config,
        userAgent,
        suppliedSources || snapshot.subscriptions,
        '',
        profile,
        false,
        skipCertVerify
    );
    await Promise.all(pending);
    return {
        output,
        context,
        status: context.subscriptionRuntimeObservations.one,
        current: await storage.readSubscriptionSnapshot(),
    };
}

describe('download observations with explicit canonical scope', () => {
    it('commits raw count but keeps single-response userInfo and title scoped to the request', async () => {
        const { output, context, status, current } = await download();
        expect(output).toContain('trojan://');
        expect(status).toMatchObject({
            status: 'applied',
            rawNodeCount: 2,
            userInfoScope: 'download_response',
        });
        expect(current.subscriptions[0]).toMatchObject({
            nodeCount: 2,
            userInfo: { upload: 1, download: 0, total: 100 },
        });
        expect(context.currentSubscriptionRuntimeInfo.one.userInfo).toEqual({
            upload: 9,
            download: 1,
            total: 10,
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['source', 'profile', 'global'])(
        'uses raw count before %s filtering',
        async (scope) => {
            if (scope === 'source') await edit({ exclude: 'Drop' });
            const { output, current, status } = await download({
                profile: scope === 'profile' ? { exclude: 'Drop' } : {},
                config: scope === 'global' ? { exclude: 'Drop' } : {},
            });
            expect(output.split('\n').filter(Boolean)).toHaveLength(1);
            expect(current.subscriptions[0].nodeCount).toBe(2);
            expect(status.status).toBe('applied');
        }
    );
    it('an intentionally empty filtered output does not write a zero count', async () => {
        await edit({ exclude: '.*' });
        const { output, current, status } = await download();
        expect(output).toBe('');
        expect(current.subscriptions[0].nodeCount).toBe(2);
        expect(status.rawNodeCount).toBe(2);
    });
    it('does not confuse a large source filter with a truncated upstream response', async () => {
        fixture.close();
        fixture = await createProtocolFixture({
            subscriptions: [
                {
                    id: 'one',
                    enabled: true,
                    url: 'https://source.example/sub',
                    nodeCount: 20,
                    exclude: 'Drop',
                },
            ],
        });
        storage = StorageFactory.createAdapter(fixture.env, 'd1');
        fetch.mockResolvedValue(
            new Response(
                Array.from(
                    { length: 20 },
                    (_, index) =>
                        `trojan://synthetic@node-${index}.example.com:443#${index ? 'Drop' : 'Keep'}`
                ).join('\n')
            )
        );
        const { output, status, current } = await download();
        expect(output.split('\n').filter(Boolean)).toHaveLength(1);
        expect(status.status).toBe('applied');
        expect(current.subscriptions[0]).toMatchObject({ nodeCount: 20, lastGoodNodeCount: 20 });
    });
    it('preserves the healthy count for a genuinely truncated raw response', async () => {
        fixture.close();
        fixture = await createProtocolFixture({
            subscriptions: [
                {
                    id: 'one',
                    enabled: true,
                    url: 'https://source.example/sub',
                    nodeCount: 100,
                },
            ],
        });
        storage = StorageFactory.createAdapter(fixture.env, 'd1');
        const { output, status, current } = await download();
        expect(output).toBe('');
        expect(status).toMatchObject({ status: 'skipped', reason: 'observation_protected' });
        expect(current.subscriptions[0].nodeCount).toBe(100);
        expect(current.version.revision).toBe(0);
    });
    it('processes encoded content with the canonical raw parser', async () => {
        fetch.mockResolvedValue(new Response(btoa(nodes.join('\n'))));
        const { status, current } = await download();
        expect(status.status).toBe('applied');
        expect(current.subscriptions[0].nodeCount).toBe(2);
    });
    it('accepts the stored custom UA even when the client UA differs', async () => {
        await edit({ customUserAgent: 'Synthetic-Canonical-UA' });
        const { status } = await download({ userAgent: 'DifferentClient/1' });
        expect(fetch.mock.calls[0][0].headers.get('User-Agent')).toBe('Synthetic-Canonical-UA');
        expect(status.status).toBe('applied');
    });
    it('reports a noncanonical effective UA without preventing the download', async () => {
        const { output, status, current } = await download({ userAgent: '' });
        expect(output).toContain('trojan://');
        expect(status).toMatchObject({ status: 'scoped', reason: 'user_agent_scope' });
        expect(current.version.revision).toBe(0);
    });
    it.each([
        [false, true],
        [true, false],
    ])('reports TLS scope mismatch policy=%s download=%s', async (policy, tls) => {
        await settings({ builtinSkipCertVerify: policy });
        const { output, status, current } = await download({ skipCertVerify: tls });
        expect(output).toContain('trojan://');
        expect(status).toMatchObject({ status: 'scoped', reason: 'tls_scope' });
        expect(current.version.revision).toBe(1);
        expect(Boolean(fetch.mock.calls[0][1]?.cf?.insecureSkipVerify)).toBe(tls);
    });
    it('uses the exact canonical TLS flag when the policy and download agree', async () => {
        await settings({ builtinSkipCertVerify: true });
        const { status } = await download({ skipCertVerify: true });
        expect(status.status).toBe('applied');
        expect(fetch.mock.calls[0][1]).toEqual({ cf: { insecureSkipVerify: true } });
    });
    it('reports cache-busted responses as scoped even when fresh nodes were received', async () => {
        await edit({ enableNodeCache: true });
        const { output, status, current } = await download();
        expect(output).toContain('trojan://');
        expect(new URL(fetch.mock.calls[0][0].url).searchParams.has('_t')).toBe(true);
        expect(status).toMatchObject({ status: 'scoped', reason: 'cache_scope' });
        expect(current.version.revision).toBe(1);
    });
    it('returns cache fallback without turning it into a canonical observation or zero', async () => {
        await edit({ enableNodeCache: true });
        const source = (await storage.readSubscriptionSnapshot()).subscriptions[0];
        await storage.put(cacheKey(source), { nodes });
        fetch.mockResolvedValue(new Response('Fixture unavailable', { status: 403 }));
        const { output, status, current } = await download();
        expect(output).toContain('trojan://');
        expect(status).toMatchObject({ status: 'scoped', reason: 'cache_scope' });
        expect(current.subscriptions[0].nodeCount).toBeUndefined();
    });
    it.each(['', 'Forbidden\n' + nodes[0]])(
        'does not commit empty/error response bodies',
        async (body) => {
            fetch.mockResolvedValue(new Response(body));
            const { status, current } = await download();
            expect(status).toMatchObject({
                status: 'skipped',
                reason: 'invalid_or_empty_response',
            });
            expect(current.version.revision).toBe(0);
        }
    );
    it('does not write zero after an HTTP failure', async () => {
        fetch.mockResolvedValue(new Response('Denied', { status: 403 }));
        const { status, current } = await download();
        expect(status).toMatchObject({ status: 'skipped', reason: 'fetch_failed' });
        expect(current.version.revision).toBe(0);
    });
    it.each(['name', 'url', 'remove', 'recreate', 'restore', 'policy'])(
        'handles %s during the in-flight response',
        async (mutation) => {
            fetch.mockImplementationOnce(async () => {
                const snapshot = await storage.readSubscriptionSnapshot();
                if (mutation === 'restore') {
                    await storage.restoreSubscriptionSnapshot({
                        operationId: 'synthetic-restore',
                        baseVersion: snapshot.version,
                        nextEpoch: 'restored-epoch',
                        subscriptions: snapshot.subscriptions,
                        profiles: [],
                    });
                } else if (mutation === 'policy') await settings({ builtinSkipCertVerify: true });
                else if (mutation === 'name' || mutation === 'url')
                    await edit({
                        [mutation]: mutation === 'name' ? 'Edited' : 'https://new.example/sub',
                    });
                else {
                    const operations = [
                        { type: 'remove', collection: 'subscriptions', ids: ['one'] },
                    ];
                    if (mutation === 'recreate')
                        operations.push({
                            type: 'create',
                            collection: 'subscriptions',
                            item: {
                                id: 'one',
                                enabled: true,
                                url: 'https://source.example/sub',
                                name: 'Recreated',
                            },
                        });
                    await storage.commitSubscriptionOperations({
                        operationId: 'synthetic-edit',
                        baseVersion: snapshot.version,
                        operations,
                    });
                }
                return new Response(nodes.join('\n'));
            });
            const { output, status, current } = await download();
            expect(output).toContain('trojan://');
            if (mutation === 'name') {
                expect(status.status).toBe('applied');
                expect(current.subscriptions[0]).toMatchObject({ name: 'Edited', nodeCount: 2 });
            } else {
                expect(status.status).toBe('rejected');
                if (mutation === 'restore') expect(status.reason).toBe('epoch_conflict');
                expect(current.subscriptions[0]?.nodeCount).toBeUndefined();
            }
        }
    );
    it('records a failed commit while preserving the generated download', async () => {
        fixture.state.failAt = 3;
        const { output, status, current } = await download();
        expect(output).toContain('trojan://');
        expect(status).toMatchObject({ status: 'error', reason: 'storage_unavailable' });
        expect(current.version.revision).toBe(0);
    });
    it('retains parallel downloads but commits observations in sequence', async () => {
        const snapshot = await storage.readSubscriptionSnapshot();
        await storage.commitSubscriptionOperations({
            operationId: 'add-many',
            baseVersion: snapshot.version,
            operations: Array.from({ length: 7 }, (_, index) => ({
                type: 'create',
                collection: 'subscriptions',
                item: {
                    id: `extra-${index}`,
                    enabled: true,
                    url: `https://source.example/${index}`,
                },
            })),
        });
        let active = 0;
        let peak = 0;
        fetch.mockImplementation(async () => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return new Response(nodes.join('\n'));
        });
        const { context, current } = await download();
        expect(peak).toBe(4);
        expect(
            Object.values(context.subscriptionRuntimeObservations).every(
                (status) => status.status === 'applied'
            )
        ).toBe(true);
        expect(current.version.revision).toBe(9);
    });
});
