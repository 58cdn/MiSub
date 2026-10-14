import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useSettingsStore } from '../../src/stores/settings.js';

const { get, post, showToast } = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    showToast: vi.fn(),
}));
vi.mock('../../src/lib/http.js', () => ({ api: { get, post } }));
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));

const clone = (value) => JSON.parse(JSON.stringify(value));
const node = (id) => ({ id, name: id, url: `https://example.invalid/${id}`, enabled: true });
const data = () => ({
    misubs: [node('a'), node('b')],
    profiles: [{ id: 'p', name: 'group', subscriptions: ['a', 'b'], manualNodes: [] }],
    ruleTemplates: [{ id: 'r', name: 'rules', rules: ['MATCH,DIRECT'] }],
    config: { siteName: 'fixture' },
});
const response = (payload) => ({ success: true, data: clone(payload) });
const cache = () => JSON.parse(sessionStorage.getItem('misub_data_cache'));
function deferred() {
    let resolve;
    let reject;
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

describe('data store authoritative baseline and local edit integrity', () => {
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

    it.each([
        ['missing response', undefined],
        ['empty object', {}],
        ['missing profiles', { misubs: [] }],
        ['failed response', { ...data(), success: false }],
        ['error response', { ...data(), error: 'read failed' }],
        ['wrong subscriptions type', { ...data(), misubs: {} }],
        ['null subscription', { ...data(), misubs: [null] }],
        ['empty subscription', { ...data(), misubs: [{}] }],
        ['blank subscription ID', { ...data(), misubs: [{ id: ' ' }] }],
        ['numeric subscription ID', { ...data(), misubs: [{ id: 1 }] }],
        ['duplicate subscription IDs', { ...data(), misubs: [node('a'), node('a')] }],
        [
            'conflicting subscription IDs',
            { ...data(), misubs: [node('a'), { ...node('a'), name: 'conflict' }] },
        ],
        ['wrong profiles type', { ...data(), profiles: {} }],
        ['primitive profile', { ...data(), profiles: ['p'] }],
        ['missing profile ID', { ...data(), profiles: [{}] }],
        ['duplicate profile IDs', { ...data(), profiles: [{ id: 'p' }, { id: 'p' }] }],
        [
            'conflicting profile IDs',
            { ...data(), profiles: [{ id: 'p' }, { id: 'p', name: 'conflict' }] },
        ],
        ['nonboolean success', { ...data(), success: 0 }],
        ['missing templates', { ...data(), ruleTemplates: undefined }],
        ['wrong templates type', { ...data(), ruleTemplates: {} }],
        ['wrong config type', { ...data(), config: [] }],
        ['unserializable config', { ...data(), config: { counter: 1n } }],
    ])('rejects %s without partially hydrating', (_label, invalid) => {
        const store = loaded();
        store.subscriptions[0].name = 'unsaved';
        store.markDirty();
        const before = clone({
            subs: store.subscriptions,
            profiles: store.profiles,
            rules: store.ruleTemplates,
            config: useSettingsStore().config,
        });
        const previousTime = store.lastUpdated;
        const previousCache = sessionStorage.getItem('misub_data_cache');
        expect(store.hydrateFromData(invalid)).toBe(false);
        expect(
            clone({
                subs: store.subscriptions,
                profiles: store.profiles,
                rules: store.ruleTemplates,
                config: useSettingsStore().config,
            })
        ).toEqual(before);
        expect(store.lastUpdated).toEqual(previousTime);
        expect(sessionStorage.getItem('misub_data_cache')).toBe(previousCache);
        expect(store.isDirty).toBe(true);
        expect(store.isSavedNode(node('a'))).toBe(true);
    });

    it('clones all loaded collections before publishing them', () => {
        const input = data();
        const store = useDataStore();
        expect(store.hydrateFromData(input)).toBe(true);
        input.profiles[0].subscriptions.push('foreign');
        input.ruleTemplates[0].rules.push('foreign');
        expect(store.profiles[0].subscriptions).toEqual(['a', 'b']);
        expect(store.ruleTemplates[0].rules).toEqual(['MATCH,DIRECT']);
    });

    it.each([undefined, {}, { misubs: [] }])(
        'fetch reports malformed data as failure and preserves edits',
        async (invalid) => {
            const store = loaded();
            store.addSubscription(node('local'));
            const previousCache = cache();
            get.mockResolvedValue(invalid);
            expect(await store.fetchData(true)).toBe(false);
            expect(store.subscriptions.map((item) => item.id)).toEqual(['local', 'a', 'b']);
            expect(store.isDirty).toBe(true);
            expect(cache()).toEqual(previousCache);
            expect(showToast).toHaveBeenCalledTimes(1);
        }
    );

    it('does not submit without a complete authoritative load', async () => {
        const store = useDataStore();
        store.addSubscription(node('local'));
        post.mockResolvedValue(response({ misubs: [], profiles: [] }));
        expect(await store.saveData()).toBe(false);
        expect(post).not.toHaveBeenCalled();
        expect(store.isDirty).toBe(true);
    });

    it('uses cached data for display while a failed GET leaves saving unavailable', async () => {
        sessionStorage.setItem('misub_data_cache', JSON.stringify(data()));
        sessionStorage.setItem('misub_data_cache_ts', String(Date.now()));
        get.mockRejectedValue(new Error('offline fixture'));
        const store = useDataStore();
        expect(await store.fetchData()).toBe(false);
        expect(get).toHaveBeenCalledOnce();
        expect(store.subscriptions.map((item) => item.id)).toEqual(['a', 'b']);
        expect(store.isSavedNode(node('a'))).toBe(false);
        expect(await store.saveData()).toBe(false);
        expect(post).not.toHaveBeenCalled();
        expect(cache()).toEqual(data());
    });

    it('ignores a malformed cache and loads a complete server baseline', async () => {
        sessionStorage.setItem('misub_data_cache', JSON.stringify({ misubs: [] }));
        sessionStorage.setItem('misub_data_cache_ts', String(Date.now()));
        get.mockResolvedValue(data());
        const store = useDataStore();
        expect(await store.fetchData()).toBe(true);
        expect(get).toHaveBeenCalledOnce();
        expect(store.isSavedNode(node('a'))).toBe(true);
    });

    it('accepts a complete authoritative empty collection', async () => {
        const store = useDataStore();
        get.mockResolvedValue({ misubs: [], profiles: [], ruleTemplates: [], config: {} });
        expect(await store.fetchData()).toBe(true);
        post.mockResolvedValue(response({ misubs: [], profiles: [] }));
        expect(await store.saveData()).toBe(true);
        expect(post).toHaveBeenCalledOnce();
    });

    it('retains a previously complete baseline after a refresh fails', async () => {
        const store = loaded();
        get.mockRejectedValue(new Error('offline fixture'));
        expect(await store.fetchData(true)).toBe(false);
        expect(store.isSavedNode(node('a'))).toBe(true);
        store.addSubscription(node('later'));
        post.mockImplementation((_url, payload) => Promise.resolve(response(payload)));
        expect(await store.saveData()).toBe(true);
        expect(post).toHaveBeenCalledOnce();
    });

    it('can retry after a synchronous request failure', async () => {
        const store = useDataStore();
        get.mockImplementationOnce(() => {
            throw new Error('synchronous fixture');
        });
        expect(await store.fetchData()).toBe(false);
        get.mockResolvedValue(data());
        expect(await store.fetchData()).toBe(true);
        expect(get).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['add', (store) => store.addSubscription(node('new'))],
        ['modify', (store) => store.updateSubscription('a', { name: 'new name' })],
        [
            'delete',
            (store) => {
                store.removeSubscription('b');
                store.markDirty();
            },
        ],
        [
            'reorder',
            (store) => {
                store.subscriptions.reverse();
                store.markDirty();
            },
        ],
        [
            'direct ref edit',
            (store) => {
                store.subscriptions[0].url = 'https://example.invalid/changed';
            },
        ],
        [
            'direct profile edit',
            (store) => {
                store.profiles[0].subscriptions.push('new');
            },
        ],
        ['markDirty only', (store) => store.markDirty()],
    ])(
        'preserves %s during a pending save and caches only confirmed state',
        async (_label, edit) => {
            const store = loaded();
            store.updateSubscription('a', { name: 'submitted' });
            const wait = deferred();
            post.mockReturnValue(wait.promise);
            const pending = store.saveData();
            const sent = clone(post.mock.calls[0][1]);
            edit(store);
            const edited = clone({ misubs: store.subscriptions, profiles: store.profiles });
            wait.resolve(response(sent));
            expect(await pending).toBe(true);
            expect(clone({ misubs: store.subscriptions, profiles: store.profiles })).toEqual(
                edited
            );
            expect(store.isDirty).toBe(true);
            expect(store.saveState).toBe('idle');
            expect(cache().misubs).toEqual(sent.misubs);
            expect(cache().profiles).toEqual(sent.profiles);
            expect(store.isSavedNode(node('new'))).toBe(false);
            expect(store.isSavedNode(node('a'))).toBe(true);
            expect(
                store.isSavedNode({ ...node('a'), url: 'https://example.invalid/changed' })
            ).toBe(false);
        }
    );

    it('deeply freezes the submitted values from later nested edits', async () => {
        const store = loaded();
        const wait = deferred();
        post.mockReturnValue(wait.promise);
        const pending = store.saveData();
        const sent = clone(post.mock.calls[0][1]);
        store.profiles[0].subscriptions.push('later');
        expect(post.mock.calls[0][1]).toEqual(sent);
        wait.resolve(response(sent));
        await pending;
    });

    it('applies normalized server data when no later edit exists', async () => {
        const store = loaded();
        store.markDirty();
        post.mockResolvedValue(
            response({ misubs: [{ ...node('a'), name: 'normalized' }], profiles: [] })
        );
        expect(await store.saveData()).toBe(true);
        expect(store.subscriptions[0].name).toBe('normalized');
        expect(store.profiles).toEqual([]);
        expect(store.isDirty).toBe(false);
        expect(store.saveState).toBe('success');
        expect(cache().misubs[0].name).toBe('normalized');
        vi.advanceTimersByTime(2000);
        expect(store.saveState).toBe('idle');
    });

    it.each([
        ['failed', { success: false, message: 'fixture failure' }],
        ['null', null],
        ['missing data', { success: true }],
        ['missing collection', { success: true, data: { misubs: [] } }],
        ['invalid collection', { success: true, data: { misubs: [], profiles: {} } }],
        ['invalid row', { success: true, data: { misubs: [null], profiles: [] } }],
        ['missing row ID', { success: true, data: { misubs: [{}], profiles: [] } }],
        [
            'duplicate row IDs',
            { success: true, data: { misubs: [node('a'), node('a')], profiles: [] } },
        ],
        [
            'conflicting row IDs',
            {
                success: true,
                data: { misubs: [node('a'), { ...node('a'), name: 'conflict' }], profiles: [] },
            },
        ],
        ['missing profile ID', { success: true, data: { misubs: [], profiles: [{}] } }],
        [
            'duplicate profile IDs',
            { success: true, data: { misubs: [], profiles: [{ id: 'p' }, { id: 'p' }] } },
        ],
        ['truthy success', { success: 'true', data: { misubs: [], profiles: [] } }],
    ])('does not acknowledge a %s save response', async (_label, result) => {
        const store = loaded();
        store.addSubscription(node('unsaved'));
        const oldCache = cache();
        post.mockResolvedValue(result);
        expect(await store.saveData()).toBe(false);
        expect(store.subscriptions[0].id).toBe('unsaved');
        expect(store.isDirty).toBe(true);
        expect(store.isSavedNode(node('unsaved'))).toBe(false);
        expect(cache()).toEqual(oldCache);
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('preserves new edits on a rejected save', async () => {
        const store = loaded();
        const wait = deferred();
        post.mockReturnValue(wait.promise);
        const pending = store.saveData();
        store.addSubscription(node('later'));
        wait.reject(new Error('fixture failure'));
        expect(await pending).toBe(false);
        expect(store.subscriptions[0].id).toBe('later');
        expect(store.isDirty).toBe(true);
        expect(cache()).toEqual(data());
    });

    it.each(['save', 'fetch'])(
        'marks direct ref edits dirty after a rejected %s',
        async (operation) => {
            const store = loaded();
            const wait = deferred();
            (operation === 'save' ? post : get).mockReturnValue(wait.promise);
            const pending = operation === 'save' ? store.saveData() : store.fetchData(true);
            store.subscriptions[0].name = 'later direct edit';
            wait.reject(new Error('fixture failure'));
            expect(await pending).toBe(false);
            expect(store.subscriptions[0].name).toBe('later direct edit');
            expect(store.isDirty).toBe(true);
            expect(cache()).toEqual(data());
        }
    );

    it('prunes the submitted copy while a failed save retains the current references', async () => {
        const store = loaded();
        store.profiles[0].subscriptions = ['a', 'a', 'missing'];
        post.mockRejectedValue(new Error('fixture failure'));
        expect(await store.saveData()).toBe(false);
        expect(post.mock.calls[0][1].profiles[0].subscriptions).toEqual(['a']);
        expect(store.profiles[0].subscriptions).toEqual(['a', 'a', 'missing']);
        expect(store.isDirty).toBe(true);
    });

    it('does not persist unsaved ancillary editor state in the saved cache', async () => {
        const store = loaded();
        store.ruleTemplates[0].name = 'unsaved rules';
        useSettingsStore().config.siteName = 'unsaved setting';
        post.mockImplementation((_url, payload) => Promise.resolve(response(payload)));
        expect(await store.saveData()).toBe(true);
        expect(cache().ruleTemplates).toEqual(data().ruleTemplates);
        expect(cache().config).toEqual(data().config);
        expect(store.ruleTemplates[0].name).toBe('unsaved rules');
    });

    it('does not let an older success timer reset a newer save result', async () => {
        const store = loaded();
        post.mockImplementation((_url, payload) => Promise.resolve(response(payload)));
        expect(await store.saveData()).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(await store.saveData()).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(store.saveState).toBe('success');
        vi.advanceTimersByTime(1000);
        expect(store.saveState).toBe('idle');
    });

    it('does not start a duplicate save or refresh while saving', async () => {
        const store = loaded();
        const wait = deferred();
        post.mockReturnValue(wait.promise);
        const pending = store.saveData();
        expect(await store.saveData()).toBe(false);
        expect(await store.fetchData(true)).toBe(false);
        expect(post).toHaveBeenCalledOnce();
        expect(get).not.toHaveBeenCalled();
        expect(store.isLoading).toBe(true);
        wait.resolve(response(post.mock.calls[0][1]));
        expect(await pending).toBe(true);
        expect(store.isLoading).toBe(false);
    });

    it('coalesces two refreshes and keeps edits made while they are pending', async () => {
        const store = loaded();
        const wait = deferred();
        get.mockReturnValue(wait.promise);
        const first = store.fetchData(true);
        const second = store.fetchData(true);
        store.addSubscription(node('later'));
        wait.resolve(data());
        expect(await Promise.all([first, second])).toEqual([false, false]);
        expect(get).toHaveBeenCalledOnce();
        expect(store.subscriptions[0].id).toBe('later');
        expect(store.isDirty).toBe(true);
    });

    it('keeps direct ref edits made during a refresh', async () => {
        const store = loaded();
        const wait = deferred();
        get.mockReturnValue(wait.promise);
        const pending = store.fetchData(true);
        store.subscriptions.reverse();
        wait.resolve(data());
        expect(await pending).toBe(false);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['b', 'a']);
        expect(store.isDirty).toBe(true);
    });

    it('an explicit refresh can discard edits that existed before it started', async () => {
        const store = loaded();
        store.addSubscription(node('discarded'));
        get.mockResolvedValue(data());
        expect(await store.fetchData(true)).toBe(true);
        expect(store.subscriptions.map((item) => item.id)).toEqual(['a', 'b']);
        expect(store.isDirty).toBe(false);
    });

    it.each(['save', 'fetch'])(
        'ignores a pending %s response after newer authoritative hydration',
        async (operation) => {
            const store = loaded();
            const wait = deferred();
            (operation === 'save' ? post : get).mockReturnValue(wait.promise);
            const pending = operation === 'save' ? store.saveData() : store.fetchData(true);
            const newer = { ...data(), misubs: [node('newer')] };
            expect(store.hydrateFromData(newer)).toBe(true);
            store.markDirty();
            const newCache = cache();
            wait.resolve(operation === 'save' ? response({ misubs: [], profiles: [] }) : data());
            expect(await pending).toBe(false);
            expect(store.subscriptions.map((item) => item.id)).toEqual(['newer']);
            expect(store.isSavedNode(node('newer'))).toBe(true);
            expect(cache()).toEqual(newCache);
            expect(store.isDirty).toBe(true);
        }
    );

    it.each(['save', 'fetch'])(
        'clearing a session invalidates a pending %s response and baseline',
        async (operation) => {
            const store = loaded();
            const wait = deferred();
            (operation === 'save' ? post : get).mockReturnValue(wait.promise);
            const pending = operation === 'save' ? store.saveData() : store.fetchData(true);
            store.clearCachedData();
            store.markDirty();
            expect(store.isSavedNode(node('a'))).toBe(false);
            wait.resolve(operation === 'save' ? response({ misubs: [], profiles: [] }) : data());
            expect(await pending).toBe(false);
            expect(cache()).toBeNull();
            expect(store.subscriptions).toEqual([]);
            expect(store.isDirty).toBe(true);
            expect(await store.saveData()).toBe(false);
        }
    );

    it('starts a fresh session request while an invalidated operation is still pending', async () => {
        const store = loaded();
        const old = deferred();
        post.mockReturnValue(old.promise);
        const pending = store.saveData();
        store.clearCachedData();
        store.hydrateFromData(data());
        const current = deferred();
        get.mockReturnValue(current.promise);
        const refresh = store.fetchData(true);
        expect(get).toHaveBeenCalledTimes(1);
        old.resolve(response({ misubs: [], profiles: [] }));
        expect(await pending).toBe(false);
        expect(store.isLoading).toBe(true);
        expect(await store.saveData()).toBe(false);
        current.resolve(data());
        expect(await refresh).toBe(true);
        expect(store.isLoading).toBe(false);
    });
});
