import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';

vi.mock('../../src/stores/toast', () => ({ useToastStore: () => ({ showToast: vi.fn() }) }));
const data = (name = 'original', revision = 0) => ({
    misubs: [{ id: 'a', name, url: 'https://fixture.invalid/a' }],
    profiles: [{ id: 'p', subscriptions: ['a'] }],
    ruleTemplates: [{ id: 'r', name }],
    config: { storageType: 'd1', mytoken: 'synthetic-private' },
    subscriptionProtocol: 'd1-v1',
    version: { epoch: 'fixture-epoch', revision },
});
const response = (value) => new Response(JSON.stringify(value));
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function acknowledge(call, name = 'new edit') {
    const request = JSON.parse(call[1].body),
        snapshot = data(name, 11);
    return response({
        success: true,
        data: snapshot,
        receipt: { operationId: request.operationId, version: snapshot.version },
    });
}
beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('Unexpected offline request');
        })
    );
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('data store session invalidation', () => {
    it('clears private data, settings, cache and editor state when the session ends', () => {
        const store = useDataStore();
        store.hydrateFromData(data());
        store.markDirty();
        store.clearCachedData();
        expect(store.subscriptions).toEqual([]);
        expect(store.profiles).toEqual([]);
        expect(store.ruleTemplates).toEqual([]);
        expect(store.settings.mytoken).not.toBe('synthetic-private');
        expect(store.isDirty).toBe(false);
        expect(store.hasDataLoaded).toBe(false);
        expect(sessionStorage.getItem('misub_data_cache')).toBeNull();
    });
    it('starts a fresh GET and preserves its loading flag when an old GET completes', async () => {
        const store = useDataStore(),
            old = deferred(),
            fresh = deferred();
        fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        const previous = store.fetchData(true);
        store.clearCachedData();
        const next = store.fetchData(true);
        expect(fetch).toHaveBeenCalledTimes(2);
        old.resolve(response(data('old')));
        expect(await previous).toBe(false);
        expect(store.isLoading).toBe(true);
        fresh.resolve(response(data('new', 10)));
        expect(await next).toBe(true);
        expect(store.subscriptions[0].name).toBe('new');
        expect(store.isLoading).toBe(false);
    });
    it.each(['save', 'runtime'])('isolates a pending %s from a new session save', async (kind) => {
        const store = useDataStore(),
            old = deferred(),
            fresh = deferred();
        store.hydrateFromData(data());
        fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
        if (kind === 'save') store.updateSubscription('a', { name: 'old edit' });
        const previous = kind === 'save' ? store.saveData() : store.refreshSubscriptionRuntime('a');
        store.clearCachedData();
        store.hydrateFromData(data('new', 10));
        store.updateSubscription('a', { name: 'new edit' });
        const next = store.saveData();
        expect(fetch).toHaveBeenCalledTimes(2);
        old.resolve(response({ success: false }));
        await previous;
        expect(store.isLoading).toBe(true);
        expect(store.saveState).toBe('saving');
        fresh.resolve(acknowledge(fetch.mock.calls[1]));
        expect(await next).toBe(true);
        expect(store.subscriptions[0].name).toBe('new edit');
        expect(store.isLoading).toBe(false);
    });
    it('starts a distinct operation after a failed prior-session submission', async () => {
        const store = useDataStore();
        store.hydrateFromData(data());
        fetch.mockResolvedValue(response({ success: false }));
        store.updateSubscription('a', { name: 'old edit' });
        await store.saveData();
        const previous = JSON.parse(fetch.mock.calls[0][1].body);
        store.clearCachedData();
        store.hydrateFromData(data('new', 10));
        store.updateSubscription('a', { name: 'new edit' });
        await store.saveData();
        const next = JSON.parse(fetch.mock.calls[1][1].body);
        expect(next.operationId).not.toBe(previous.operationId);
        expect(next.baseVersion.revision).toBe(10);
        expect(next.operations).toEqual([
            { type: 'update', collection: 'subscriptions', id: 'a', fields: { name: 'new edit' } },
        ]);
    });
});
