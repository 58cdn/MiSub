import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useSubscriptions } from '../../src/composables/useSubscriptions.js';

const { get, post, showToast, fetchNodeCount, batchUpdateNodes } = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    showToast: vi.fn(),
    fetchNodeCount: vi.fn(),
    batchUpdateNodes: vi.fn(),
}));
vi.mock('../../src/lib/http.js', () => ({ api: { get, post } }));
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));
vi.mock('../../src/lib/api.js', () => ({ fetchNodeCount, batchUpdateNodes }));
const clone = (value) => JSON.parse(JSON.stringify(value));
const node = (id, name = id) => ({ id, name, url: `https://example.invalid/${id}`, enabled: true });
const version = (revision = 0) => ({ epoch: 'fixture-epoch', revision });
const data = (misubs = [node('a')], revision = 0) => ({
    misubs,
    profiles: [],
    ruleTemplates: [],
    config: {},
    subscriptionProtocol: 'd1-v1',
    version: version(revision),
});
const acknowledgement = (request, misubs, revision = 1, receiptRevision = revision) => ({
    success: true,
    data: { misubs, profiles: [], version: version(revision) },
    receipt: {
        operationId: request.operationId,
        version: version(receiptRevision),
        digest: 'a'.repeat(64),
        counts: { subscriptions: misubs.length, profiles: 0 },
        expiresAt: 9999999999999,
    },
});
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function loaded() {
    const store = useDataStore();
    expect(store.hydrateFromData(data())).toBe(true);
    return store;
}

describe('authoritative versioned subscription saves', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        sessionStorage.clear();
        vi.resetAllMocks();
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('sends explicit configuration operations with the loaded version', async () => {
        const store = loaded();
        store.subscriptions[0].name = 'changed';
        store.subscriptions[0].nodeCount = 123;
        post.mockImplementation((_url, request) =>
            acknowledgement(request, [node('a', 'changed')])
        );
        expect(await store.saveData()).toBe(true);
        expect(post.mock.calls[0][1]).toEqual({
            operationId: expect.any(String),
            baseVersion: version(),
            operations: [
                {
                    type: 'update',
                    collection: 'subscriptions',
                    id: 'a',
                    fields: { name: 'changed' },
                },
            ],
        });
        expect(store.subscriptionProtocol).toBe('d1-v1');
        store.subscriptions[0].name = 'next';
        post.mockImplementation((_url, request) =>
            acknowledgement(request, [node('a', 'next')], 2)
        );
        expect(await store.saveData()).toBe(true);
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(1));
    });
    it('keeps legacy request shape when no protocol is advertised', async () => {
        const store = useDataStore();
        const legacy = data();
        delete legacy.subscriptionProtocol;
        store.hydrateFromData(legacy);
        post.mockResolvedValue({ success: true, data: { misubs: [node('a')], profiles: [] } });
        expect(await store.saveData()).toBe(true);
        expect(post.mock.calls[0][1]).toEqual({ misubs: [node('a')], profiles: [] });
        expect(store.subscriptionProtocol).toBe('legacy');
    });
    it.each([undefined, null, { epoch: 'bad epoch', revision: 0 }, { epoch: 'ok', revision: -1 }])(
        'rejects advertised strict mode without a valid authoritative version',
        (invalid) => {
            const store = useDataStore();
            expect(store.hydrateFromData({ ...data(), version: invalid })).toBe(false);
            expect(store.hasDataLoaded).toBe(false);
        }
    );
    it('cannot establish strict mode or saving authority from cache alone', async () => {
        sessionStorage.setItem('misub_data_cache', JSON.stringify(data()));
        sessionStorage.setItem('misub_data_cache_ts', String(Date.now()));
        get.mockRejectedValue(new Error('fixture offline'));
        const store = useDataStore();
        expect(await store.fetchData()).toBe(false);
        expect(store.subscriptionProtocol).toBe('legacy');
        expect(await store.saveData()).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });
    it('does not issue a configuration write for runtime-only changes', async () => {
        const store = loaded();
        store.subscriptions[0].nodeCount = 45;
        store.markDirty();
        expect(await store.saveData()).toBe(true);
        expect(post).not.toHaveBeenCalled();
        expect(
            JSON.parse(sessionStorage.getItem('misub_data_cache')).misubs[0].nodeCount
        ).toBeUndefined();
    });
    it('reuses the original operation after a lost response and keeps later edits separate', async () => {
        const store = loaded();
        store.updateSubscription('a', { name: 'first' });
        post.mockRejectedValueOnce(new Error('response lost'));
        expect(await store.saveData()).toBe(false);
        const first = clone(post.mock.calls[0][1]);
        store.addSubscription(node('later'));
        post.mockImplementation((_url, request) => acknowledgement(request, [node('a', 'first')]));
        expect(await store.saveData()).toBe(true);
        expect(post.mock.calls[1][1]).toEqual(first);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['later', 'a']);
        expect(store.isDirty).toBe(true);
        post.mockImplementation((_url, request) =>
            acknowledgement(request, [node('later'), node('a', 'first')], 2)
        );
        expect(await store.saveData()).toBe(true);
        const third = post.mock.calls[2][1];
        expect(third.operationId).not.toBe(first.operationId);
        expect(third.baseVersion).toEqual(version(1));
        expect(third.operations.find((op) => op.type === 'create').item.id).toBe('later');
    });
    it.each([
        ['add', (store) => store.addSubscription(node('later'))],
        ['delete', (store) => store.removeSubscription('b')],
        ['reorder', (store) => store.subscriptions.reverse()],
        [
            'direct URL edit',
            (store) => {
                store.subscriptions[0].url = 'https://example.invalid/later';
            },
        ],
        [
            'revert submitted edit',
            (store) => {
                store.subscriptions[0].name = 'a';
            },
        ],
    ])('preserves a strict %s made while a request is pending', async (_label, edit) => {
        const store = useDataStore();
        store.hydrateFromData(data([node('a'), node('b')]));
        store.updateSubscription('a', { name: 'submitted' });
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const saving = store.saveData();
        edit(store);
        const edited = clone(store.subscriptions);
        pending.resolve(
            acknowledgement(post.mock.calls[0][1], [node('a', 'submitted'), node('b')])
        );
        expect(await saving).toBe(true);
        expect(store.subscriptions.map(({ isUpdating, ...item }) => item)).toEqual(
            edited.map(({ isUpdating, ...item }) => item)
        );
        expect(store.isDirty).toBe(true);
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).misubs).toEqual([
            node('a', 'submitted'),
            node('b'),
        ]);
    });
    it('keeps remote additions in a retry snapshot and never deletes them in the next operation', async () => {
        const store = loaded();
        store.updateSubscription('a', { name: 'first' });
        post.mockRejectedValueOnce(new Error('response lost'));
        await store.saveData();
        store.addSubscription(node('later'));
        post.mockImplementation((_url, request) =>
            acknowledgement(request, [node('remote'), node('a', 'first')], 2, 1)
        );
        expect(await store.saveData()).toBe(true);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['remote', 'later', 'a']);
        post.mockImplementation((_url, request) =>
            acknowledgement(request, store.subscriptions, 3)
        );
        expect(await store.saveData()).toBe(true);
        expect(post.mock.calls[2][1].operations.some((op) => op.type === 'remove')).toBe(false);
        expect(post.mock.calls[2][1].baseVersion).toEqual(version(2));
    });
    it('requires comparison if a newer snapshot conflicts with edits made after submission', async () => {
        const store = loaded();
        store.updateSubscription('a', { name: 'submitted' });
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const saving = store.saveData();
        store.updateSubscription('a', { name: 'local later' });
        pending.resolve(acknowledgement(post.mock.calls[0][1], [node('a', 'remote later')], 2, 1));
        expect(await saving).toBe(false);
        expect(store.subscriptions[0].name).toBe('local later');
        expect(store.subscriptionConflict).toBe(true);
        expect(await store.saveData()).toBe(false);
        expect(post).toHaveBeenCalledOnce();
    });
    it('blocks further posts after 409 and preserves local data and original version', async () => {
        const store = loaded();
        store.updateSubscription('a', { name: 'local' });
        post.mockRejectedValue(Object.assign(new Error('revision conflict'), { status: 409 }));
        expect(await store.saveData()).toBe(false);
        expect(await store.saveData()).toBe(false);
        expect(post).toHaveBeenCalledOnce();
        expect(store.subscriptions[0].name).toBe('local');
        expect(store.isDirty).toBe(true);
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).version).toEqual(version());
    });
    it.each(['missing receipt', 'wrong operation', 'wrong epoch', 'older snapshot'])(
        'does not accept %s and retries the same operation',
        async (kind) => {
            const store = loaded();
            store.updateSubscription('a', { name: 'changed' });
            post.mockImplementationOnce((_url, request) => {
                const result = acknowledgement(request, [node('a', 'changed')]);
                if (kind === 'missing receipt') delete result.receipt;
                if (kind === 'wrong operation') result.receipt.operationId = 'wrong';
                if (kind === 'wrong epoch') result.data.version.epoch = 'different';
                if (kind === 'older snapshot') result.data.version.revision = 0;
                return result;
            });
            expect(await store.saveData()).toBe(false);
            const first = clone(post.mock.calls[0][1]);
            post.mockImplementation((_url, request) =>
                acknowledgement(request, [node('a', 'changed')])
            );
            expect(await store.saveData()).toBe(true);
            expect(post.mock.calls[1][1]).toEqual(first);
        }
    );
    it('ignores a strict save acknowledgement after clearing the session', async () => {
        const store = loaded();
        store.updateSubscription('a', { name: 'changed' });
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const saving = store.saveData();
        store.clearCachedData();
        pending.resolve(acknowledgement(post.mock.calls[0][1], [node('a', 'changed')]));
        expect(await saving).toBe(false);
        expect(store.subscriptionProtocol).toBe('legacy');
        expect(sessionStorage.getItem('misub_data_cache')).toBeNull();
    });

    it('refreshes saved runtime by identity and version without submitting configuration', async () => {
        const store = loaded();
        post.mockResolvedValue({
            success: true,
            applied: true,
            data: { count: 999 },
            subscriptionSnapshot: {
                version: version(1),
                subscriptions: [{ ...node('a'), nodeCount: 3, userInfo: { total: 8 } }],
                profiles: [],
            },
        });
        const result = await store.refreshSubscriptionRuntime('a');
        expect(result).toMatchObject({ success: true, data: { count: 3, userInfo: { total: 8 } } });
        expect(post.mock.calls[0][0]).toBe('/api/node_count');
        expect(post.mock.calls[0][1]).toEqual({
            subscriptionId: 'a',
            baseVersion: version(),
            operationId: expect.any(String),
        });
        expect(store.isDirty).toBe(false);
        expect(store.subscriptions[0].nodeCount).toBe(3);
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).version).toEqual(version(1));
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['unsaved node', 'changed target', 'unacknowledged save'])(
        'does not refresh runtime for %s',
        async (kind) => {
            const store = loaded();
            let id = 'a';
            if (kind === 'unsaved node') {
                id = 'new';
                store.addSubscription(node(id));
            }
            if (kind === 'changed target')
                store.updateSubscription('a', { url: 'https://example.invalid/changed' });
            if (kind === 'unacknowledged save') {
                store.updateSubscription('a', { name: 'changed' });
                post.mockRejectedValueOnce(new Error('response lost'));
                await store.saveData();
            }
            post.mockClear();
            expect((await store.refreshSubscriptionRuntime(id)).success).toBe(false);
            expect(post).not.toHaveBeenCalled();
        }
    );
    it('preserves local edits and remote additions during a runtime observation', async () => {
        const store = loaded();
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const refresh = store.refreshSubscriptionRuntime('a');
        store.updateSubscription('a', { name: 'local later' });
        store.addSubscription(node('local'));
        expect(await store.saveData()).toBe(false);
        expect(await store.fetchData(true)).toBe(false);
        pending.resolve({
            success: true,
            applied: true,
            subscriptionSnapshot: {
                version: version(2),
                subscriptions: [node('remote'), { ...node('a'), nodeCount: 7 }],
                profiles: [],
            },
        });
        expect((await refresh).success).toBe(true);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['remote', 'local', 'a']);
        expect(store.subscriptions.find((item) => item.id === 'a')).toMatchObject({
            name: 'local later',
            nodeCount: 7,
        });
        expect(store.isDirty).toBe(true);
        expect(post).toHaveBeenCalledOnce();
    });
    it('does not apply protected or malformed observation results', async () => {
        const store = loaded();
        const cached = sessionStorage.getItem('misub_data_cache');
        post.mockResolvedValueOnce({
            success: true,
            applied: false,
            reason: 'observation_protected',
        });
        expect((await store.refreshSubscriptionRuntime('a')).success).toBe(false);
        post.mockResolvedValueOnce({
            success: true,
            applied: true,
            subscriptionSnapshot: { version: version(1), subscriptions: [], profiles: null },
        });
        expect((await store.refreshSubscriptionRuntime('a')).success).toBe(false);
        expect(sessionStorage.getItem('misub_data_cache')).toBe(cached);
        expect(store.isDirty).toBe(false);
    });
    it('keeps an in-flight old-URL observation out of the edited URL display', async () => {
        const store = loaded();
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const refresh = store.refreshSubscriptionRuntime('a');
        store.updateSubscription('a', { url: 'https://example.invalid/later', nodeCount: 0 });
        pending.resolve({
            success: true,
            applied: true,
            subscriptionSnapshot: {
                version: version(1),
                subscriptions: [{ ...node('a'), nodeCount: 99, userInfo: { total: 8 } }],
                profiles: [],
            },
        });
        expect((await refresh).success).toBe(false);
        expect(store.subscriptions[0]).toMatchObject({
            url: 'https://example.invalid/later',
            nodeCount: 0,
        });
        expect(store.subscriptions[0].userInfo).toBeUndefined();
        expect(store.isDirty).toBe(true);
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).misubs[0]).toMatchObject({
            url: node('a').url,
            nodeCount: 99,
        });
    });
    it('aborts timed out observations and releases the operation lock', async () => {
        const store = loaded();
        post.mockImplementation(
            (_url, _body, { signal }) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('fixture aborted')), {
                        once: true,
                    });
                })
        );
        const pending = store.refreshSubscriptionRuntime('a');
        vi.advanceTimersByTime(30000);
        expect((await pending).success).toBe(false);
        expect(store.isLoading).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(post).toHaveBeenCalledOnce();
    });
    it('ignores an observation after the session is cleared', async () => {
        const store = loaded();
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const refresh = store.refreshSubscriptionRuntime('a');
        store.clearCachedData();
        pending.resolve({
            success: true,
            applied: true,
            subscriptionSnapshot: {
                version: version(1),
                subscriptions: [{ ...node('a'), nodeCount: 7 }],
                profiles: [],
            },
        });
        expect((await refresh).success).toBe(false);
        expect(store.subscriptions[0].nodeCount).toBeUndefined();
        expect(sessionStorage.getItem('misub_data_cache')).toBeNull();
    });
    it('keeps a runtime conflict local and never retries it through configuration save', async () => {
        const store = loaded();
        post.mockRejectedValueOnce(Object.assign(new Error('revision conflict'), { status: 409 }));
        const composable = useSubscriptions(store.markDirty);
        expect(await composable.handleUpdateNodeCount('a')).toBe(false);
        expect(store.subscriptionConflict).toBe(true);
        expect(fetchNodeCount).not.toHaveBeenCalled();
        expect(batchUpdateNodes).not.toHaveBeenCalled();
        expect(post).toHaveBeenCalledOnce();
    });
    it('runs strict batch refreshes sequentially with the acknowledged version', async () => {
        const store = useDataStore();
        store.hydrateFromData(data([node('a'), node('b')]));
        let revision = 0;
        const current = [node('a'), node('b')];
        post.mockImplementation((_url, request) => {
            expect(request.baseVersion).toEqual(version(revision));
            current.find((item) => item.id === request.subscriptionId).nodeCount = 10;
            revision += 1;
            return {
                success: true,
                applied: true,
                subscriptionSnapshot: {
                    version: version(revision),
                    subscriptions: clone(current),
                    profiles: [],
                },
            };
        });
        const markDirty = vi.fn();
        const composable = useSubscriptions(markDirty);
        await composable.batchUpdateAllSubscriptions();
        expect(post.mock.calls.map((call) => call[0])).toEqual([
            '/api/node_count',
            '/api/node_count',
        ]);
        expect(store.subscriptions.map((item) => item.nodeCount)).toEqual([10, 10]);
        expect(markDirty).not.toHaveBeenCalled();
        expect(store.isDirty).toBe(false);
        expect(fetchNodeCount).not.toHaveBeenCalled();
        expect(batchUpdateNodes).not.toHaveBeenCalled();
    });
});
