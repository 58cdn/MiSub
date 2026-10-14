import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { domainMutationMetadata } from '../../src/shared/domain-mutation.js';
import { fetchSettings, saveSettings } from '../../src/lib/api.js';
import { useSettingsLogic } from '../../src/composables/useSettingsLogic.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { useEditorStore } from '../../src/stores/editor.js';

const { get, post, showToast, confirmAction, APIError } = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    showToast: vi.fn(),
    confirmAction: vi.fn(),
    APIError: class APIError extends Error {
        constructor(message, status, data) {
            super(message);
            this.status = status;
            this.data = data;
        }
    },
}));
vi.mock('../../src/lib/http.js', () => ({ api: { get, post }, APIError }));
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));
vi.mock('../../src/composables/useConfirm.js', () => ({ confirmAction }));

const version = (revision) => ({ epoch: 'domain-fixture', revision });
const settingsEnvelope = (revision = 2) => ({
    success: true,
    subscriptionProtocol: 'd1-v1',
    version: version(revision),
    data: { storageType: 'd1', FileName: 'server-name' },
});
const node = { id: 'one', name: 'One', url: 'https://fixture.invalid/sub', enabled: true };
const data = (revision = 2) => ({
    subscriptionProtocol: 'd1-v1',
    version: version(revision),
    misubs: [node],
    profiles: [],
    config: { siteName: 'Server' },
    ruleTemplates: [{ id: 'rule', name: 'Original', content: 'DOMAIN,fixture.invalid,DIRECT' }],
});
const ack = (result, payload) => ({
    ...result,
    ...(result.data && !Array.isArray(result.data)
        ? { data: { storageType: 'd1', ...result.data } }
        : {}),
    subscriptionProtocol: 'd1-v1',
    receipt: { operationId: payload.operationId, version: result.version },
});
const respond = (result, { once = false } = {}) =>
    post[once ? 'mockImplementationOnce' : 'mockImplementation']((_url, payload) =>
        Promise.resolve(ack(result, payload))
    );
function loaded() {
    const store = useDataStore();
    expect(store.hydrateFromData(data())).toBe(true);
    return store;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const clone = (value) => JSON.parse(JSON.stringify(value));

beforeEach(() => {
    vi.resetAllMocks();
    setActivePinia(createPinia());
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('domain request lifecycle and submitted snapshots', () => {
    it.each(['settings', 'rules'])(
        'invalidates a %s GET started during save once its ACK commits',
        async (domain) => {
            const saveResponse = deferred(),
                getResponse = deferred();
            let target;
            if (domain === 'settings') {
                target = useSettingsLogic();
                get.mockResolvedValueOnce(settingsEnvelope());
                await target.loadSettings();
                target.settings.value.FileName = 'submitted';
            } else {
                target = loaded();
                target.ruleTemplates[0].name = 'Submitted';
            }
            post.mockReturnValueOnce(saveResponse.promise);
            const saving = domain === 'settings' ? target.handleSave() : target.saveRuleTemplates();
            get.mockReturnValueOnce(getResponse.promise);
            const reading =
                domain === 'settings' ? target.loadSettings() : target.fetchRuleTemplates();
            const confirmed =
                domain === 'settings'
                    ? { ...settingsEnvelope(3), data: { storageType: 'd1', FileName: 'submitted' } }
                    : { success: true, version: version(3), data: clone(target.ruleTemplates) };
            saveResponse.resolve(ack(confirmed, post.mock.calls[0][1]));
            await saving;
            getResponse.resolve(
                domain === 'settings'
                    ? settingsEnvelope()
                    : {
                          success: true,
                          subscriptionProtocol: 'd1-v1',
                          version: version(2),
                          data: data().ruleTemplates,
                      }
            );
            expect(await reading).toBe(false);
            expect(
                domain === 'settings'
                    ? target.settings.value.FileName
                    : target.ruleTemplates[0].name
            ).toBe(domain === 'settings' ? 'submitted' : 'Submitted');
        }
    );

    it.each([{}, { storageType: 'kv' }])(
        'rejects incomplete strict settings GET and ACK data %j',
        async (invalid) => {
            const logic = useSettingsLogic();
            get.mockResolvedValueOnce({ ...settingsEnvelope(), data: invalid });
            expect(await logic.loadSettings()).toBe(false);
            expect(await logic.handleSave()).toBe(false);
            expect(post).not.toHaveBeenCalled();
            get.mockResolvedValueOnce(settingsEnvelope());
            await logic.loadSettings();
            const reply = (_url, payload) =>
                Promise.resolve({
                    ...settingsEnvelope(3),
                    data: invalid,
                    receipt: { operationId: payload.operationId, version: version(3) },
                });
            post.mockImplementation(reply);
            expect(await logic.handleSave()).toBe(false);
            expect(logic.restartCountdown.value).toBeNull();
            const store = loaded();
            await expect(store.saveSettings({ siteName: 'Submitted' })).rejects.toThrow();
            expect(store.settings.siteName).toBe('Server');
        }
    );

    it.each(['settings', 'rules'])(
        'ignores a late %s save and does not unlock a new request',
        async (domain) => {
            const store = loaded(),
                first = deferred(),
                second = deferred();
            const save = () =>
                domain === 'settings'
                    ? store.saveSettings({ siteName: 'Submitted' })
                    : store.saveRuleTemplates();
            post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
            const old = save();
            store.clearCachedData();
            store.hydrateFromData({ ...data(100), config: { siteName: 'New session' } });
            const current = save();
            first.resolve(
                ack(
                    {
                        success: true,
                        version: version(3),
                        data: domain === 'settings' ? { siteName: 'Old' } : [],
                    },
                    post.mock.calls[0][1]
                )
            );
            expect(await old).toBe(false);
            expect(useEditorStore().isLoading).toBe(true);
            expect(store.settings.siteName).toBe('New session');
            expect(store.ruleTemplates).toHaveLength(1);
            second.resolve(
                ack(
                    {
                        success: true,
                        version: version(101),
                        data:
                            domain === 'settings'
                                ? { siteName: 'Submitted' }
                                : data().ruleTemplates,
                    },
                    post.mock.calls[1][1]
                )
            );
            await current;
            expect(useEditorStore().isLoading).toBe(false);
        }
    );

    it('snapshots rule arguments and preserves pending edits, additions, deletions and order only in the editor', async () => {
        const store = loaded();
        store.ruleTemplates = ['a', 'b', 'c'].map((id) => ({
            id,
            name: id,
            content: 'DOMAIN,fixture.invalid,DIRECT',
        }));
        const submitted = clone(store.ruleTemplates),
            pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const task = store.saveRuleTemplates();
        store.ruleTemplates[0].name = 'Edited';
        store.ruleTemplates.splice(1, 1);
        store.ruleTemplates = [
            store.ruleTemplates[1],
            { id: 'd', name: 'Added' },
            store.ruleTemplates[0],
        ];
        expect(post.mock.calls[0][1].templates).toEqual(submitted);
        pending.resolve(
            ack({ success: true, version: version(3), data: submitted }, post.mock.calls[0][1])
        );
        await task;
        expect(store.ruleTemplates.map((item) => item.id)).toEqual(['c', 'd', 'a']);
        expect(store.ruleTemplates[2].name).toBe('Edited');
        expect(useEditorStore().isDirty).toBe(true);
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).ruleTemplates).toEqual(
            submitted
        );
    });

    it('keeps a rule edit when the newer readback deleted its row and forces the next CAS to use the receipt version', async () => {
        const store = loaded(),
            pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const task = store.saveRuleTemplates();
        store.ruleTemplates[0].name = 'Local pending';
        pending.resolve({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(4),
            receipt: { operationId: post.mock.calls[0][1].operationId, version: version(3) },
            data: [],
        });
        await task;
        expect(store.ruleTemplates[0].name).toBe('Local pending');
        post.mockRejectedValue(new APIError('revision_conflict', 409));
        await expect(store.saveRuleTemplates()).rejects.toThrow('revision_conflict');
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(3));
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).ruleTemplates).toEqual([]);
    });

    it('preserves pending config edits but caches only the server snapshot and uses receipt for retry', async () => {
        const store = loaded(),
            pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const task = store.saveSettings({ siteName: 'Submitted' });
        store.settings.siteName = 'Pending';
        pending.resolve({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(4),
            receipt: { operationId: post.mock.calls[0][1].operationId, version: version(3) },
            data: { storageType: 'd1', siteName: 'Concurrent server' },
        });
        await task;
        expect(store.settings.siteName).toBe('Pending');
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).config.siteName).toBe(
            'Concurrent server'
        );
        post.mockRejectedValue(new APIError('revision_conflict', 409));
        await expect(store.saveSettings({ siteName: 'Pending' })).rejects.toThrow(
            'revision_conflict'
        );
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(3));
    });

    it('uses an unedited newer settings readback as the displayed and saved snapshot', async () => {
        const store = loaded();
        store.hydrateFromData({ ...data(), config: { siteName: 'Server', obsolete: 'old' } });
        post.mockImplementationOnce((_url, payload) =>
            Promise.resolve({
                success: true,
                subscriptionProtocol: 'd1-v1',
                version: version(4),
                receipt: { operationId: payload.operationId, version: version(3) },
                data: { storageType: 'd1', siteName: 'Concurrent server' },
            })
        );
        await store.saveSettings({ siteName: 'Submitted' });
        expect(store.settings.siteName).toBe('Concurrent server');
        expect(JSON.parse(sessionStorage.getItem('misub_data_cache')).config).toEqual({
            storageType: 'd1',
            siteName: 'Concurrent server',
        });
        expect(store.settings.obsolete).toBeUndefined();
        respond({ success: true, version: version(5), data: { siteName: 'Next' } });
        await store.saveSettings({ siteName: 'Next' });
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(4));
    });

    it('rejects duplicate domain saves without releasing the outstanding request', async () => {
        const store = loaded(),
            pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const task = store.saveRuleTemplates();
        await expect(store.saveRuleTemplates()).rejects.toThrow();
        expect(post).toHaveBeenCalledOnce();
        expect(useEditorStore().isLoading).toBe(true);
        pending.resolve(
            ack(
                { success: true, version: version(3), data: store.ruleTemplates },
                post.mock.calls[0][1]
            )
        );
        await task;
        expect(useEditorStore().isLoading).toBe(false);
    });

    it('keeps the newest rule GET and preserves edits made during the next GET', async () => {
        const store = loaded(),
            first = deferred(),
            second = deferred(),
            third = deferred();
        get.mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise);
        const old = store.fetchRuleTemplates(),
            current = store.fetchRuleTemplates();
        second.resolve({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(5),
            data: [{ id: 'r', name: 'Fresh' }],
        });
        await current;
        first.resolve({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(3),
            data: [],
        });
        expect(await old).toBe(false);
        const editing = store.fetchRuleTemplates();
        store.ruleTemplates[0].name = 'Edited';
        third.resolve({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(6),
            data: [],
        });
        expect(await editing).toBe(false);
        expect(store.ruleTemplates).toEqual([{ id: 'r', name: 'Edited' }]);
        respond({ success: true, version: version(7), data: store.ruleTemplates });
        await store.saveRuleTemplates();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(5));
    });

    it.each(['operation', 'epoch', 'revision', 'snapshot', 'data'])(
        'rejects an unrelated or malformed strict rule ACK: %s',
        async (kind) => {
            const store = loaded();
            post.mockImplementationOnce((_url, payload) => {
                const result = ack(
                    { success: true, version: version(3), data: clone(store.ruleTemplates) },
                    payload
                );
                if (kind === 'operation') result.receipt.operationId = 'unrelated';
                if (kind === 'epoch') result.receipt.version = { epoch: 'other', revision: 3 };
                if (kind === 'revision') result.receipt.version = version(2);
                if (kind === 'snapshot') result.version = version(2);
                if (kind === 'data') result.data = [{}];
                return Promise.resolve(result);
            });
            await expect(store.saveRuleTemplates()).rejects.toThrow();
            expect(store.ruleTemplates).toEqual(data().ruleTemplates);
            respond({ success: true, version: version(3), data: data().ruleTemplates });
            await store.saveRuleTemplates();
            expect(post.mock.calls[1][1].baseVersion).toEqual(version(2));
        }
    );

    it('invalidates a standalone settings save on an accepted new load and retains the new save loading flag', async () => {
        const logic = useSettingsLogic();
        get.mockResolvedValueOnce(settingsEnvelope());
        await logic.loadSettings();
        const first = deferred(),
            second = deferred();
        post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const old = logic.handleSave();
        get.mockResolvedValueOnce(settingsEnvelope(100));
        await logic.loadSettings();
        logic.settings.value.FileName = 'new-session';
        const current = logic.handleSave();
        first.resolve(ack(settingsEnvelope(3), post.mock.calls[0][1]));
        expect(await old).toBe(false);
        expect(logic.isSaving.value).toBe(true);
        expect(logic.settings.value.FileName).toBe('new-session');
        second.resolve(
            ack(
                { ...settingsEnvelope(101), data: { storageType: 'd1', FileName: 'new-session' } },
                post.mock.calls[1][1]
            )
        );
        expect(await current).toBe(true);
    });

    it('deep snapshots standalone settings and preserves pending nested edits without reloading', async () => {
        const logic = useSettingsLogic();
        get.mockResolvedValue(settingsEnvelope());
        await logic.loadSettings();
        const pending = deferred();
        post.mockReturnValueOnce(pending.promise);
        const task = logic.handleSave();
        logic.disguiseConfig.value.redirectUrl = 'https://fixture.invalid/new';
        expect(post.mock.calls[0][1].settings.disguise.redirectUrl).toBe('');
        pending.resolve(
            ack(
                { ...settingsEnvelope(3), data: post.mock.calls[0][1].settings },
                post.mock.calls[0][1]
            )
        );
        expect(await task).toBe(true);
        expect(logic.disguiseConfig.value.redirectUrl).toBe('https://fixture.invalid/new');
        expect(logic.restartCountdown.value).toBeNull();
    });

    it('cancels a reload countdown when the settings editor changes after ACK', async () => {
        const logic = useSettingsLogic();
        get.mockResolvedValue(settingsEnvelope());
        await logic.loadSettings();
        respond(settingsEnvelope(3));
        await logic.handleSave();
        expect(logic.restartCountdown.value).toBe(3);
        logic.settings.value.FileName = 'Keep editing';
        vi.advanceTimersByTime(1000);
        expect(logic.restartCountdown.value).toBeNull();
    });

    it('does not let late settings GETs overwrite a newer load or edits made during GET', async () => {
        const logic = useSettingsLogic(),
            first = deferred(),
            second = deferred(),
            third = deferred();
        get.mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise);
        const old = logic.loadSettings(),
            current = logic.loadSettings();
        second.resolve(settingsEnvelope(5));
        await current;
        first.resolve({ ...settingsEnvelope(3), data: { FileName: 'Old' } });
        expect(await old).toBe(false);
        const edit = logic.loadSettings();
        logic.settings.value.FileName = 'Local';
        third.resolve(settingsEnvelope(7));
        expect(await edit).toBe(false);
        expect(logic.settings.value.FileName).toBe('Local');
        respond(settingsEnvelope(8));
        await logic.handleSave();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(5));
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('frontend domain metadata and settings transport', () => {
    it('blocks save and reset until a settings GET succeeds', async () => {
        const logic = useSettingsLogic();
        expect(await logic.handleSave()).toBe(false);
        await logic.handleReset();
        expect(post).not.toHaveBeenCalled();
        expect(confirmAction).not.toHaveBeenCalled();
        get.mockRejectedValue(new APIError('offline', 503));
        await logic.loadSettings();
        expect(await logic.handleSave()).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });
    it('requires a valid advertised strict version and adds restore epoch independently', () => {
        const baseline = settingsEnvelope();
        const metadata = domainMutationMetadata(baseline, { restore: true });
        expect(metadata).toEqual({
            baseVersion: version(2),
            operationId: expect.any(String),
            nextEpoch: expect.any(String),
        });
        expect(metadata.operationId).not.toBe(metadata.nextEpoch);
        baseline.version.revision = 99;
        expect(metadata.baseVersion).toEqual(version(2));
        expect(() => domainMutationMetadata({ subscriptionProtocol: 'd1-v1' })).toThrow(
            'version_required'
        );
        expect(domainMutationMetadata({ data: {} })).toEqual({});
    });
    it('preserves the strict GET envelope and sends settings beside its baseline metadata', async () => {
        const envelope = settingsEnvelope();
        get.mockResolvedValue(envelope);
        expect(await fetchSettings()).toEqual(envelope);
        respond(settingsEnvelope(3));
        const metadata = domainMutationMetadata(envelope);
        await saveSettings({ FileName: 'edited' }, metadata);
        expect(post).toHaveBeenCalledWith('/api/settings', {
            settings: { FileName: 'edited' },
            ...metadata,
        });
    });
    it('retains the legacy flat settings GET and POST shapes', async () => {
        const legacy = { FileName: 'legacy', storageType: 'kv' };
        get.mockResolvedValue(legacy);
        expect(await fetchSettings()).toEqual({ success: true, data: legacy });
        post.mockResolvedValue({ success: true });
        await saveSettings(legacy);
        expect(post).toHaveBeenCalledWith('/api/settings', legacy);
    });
    it('loads settings into the editor and advances only to the acknowledged settings response', async () => {
        get.mockResolvedValue(settingsEnvelope(2));
        respond(settingsEnvelope(3));
        const logic = useSettingsLogic();
        await logic.loadSettings();
        expect(logic.settings.value.FileName).toBe('server-name');
        logic.settings.value.FileName = 'edited';
        expect(await logic.handleSave()).toBe(true);
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(2));
        expect(post.mock.calls[0][1].settings.FileName).toBe('edited');
        respond(settingsEnvelope(4));
        logic.settings.value.FileName = 'second';
        await logic.handleSave();
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(3));
        expect(get).toHaveBeenCalledOnce();
    });
    it('keeps settings edits and the old baseline on a 409 without refreshing and retrying automatically', async () => {
        get.mockResolvedValue(settingsEnvelope());
        post.mockRejectedValue(
            new APIError('revision_conflict', 409, { error: 'revision_conflict' })
        );
        const logic = useSettingsLogic();
        await logic.loadSettings();
        logic.settings.value.FileName = 'unsaved';
        expect(await logic.handleSave()).toBe(false);
        expect(logic.settings.value.FileName).toBe('unsaved');
        expect(logic.restartCountdown.value).toBeNull();
        expect(post).toHaveBeenCalledOnce();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(2));
        expect(get).toHaveBeenCalledOnce();
    });
    it('preserves an existing settings editor and baseline when a later GET fails', async () => {
        get.mockResolvedValueOnce(settingsEnvelope()).mockRejectedValueOnce(
            new APIError('offline', 503)
        );
        const logic = useSettingsLogic();
        await logic.loadSettings();
        logic.settings.value.FileName = 'unsaved';
        await logic.loadSettings();
        expect(logic.settings.value.FileName).toBe('unsaved');
        respond(settingsEnvelope(3));
        await logic.handleSave();
        expect(post.mock.calls[0][1].settings.FileName).toBe('unsaved');
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(2));
    });
    it('rejects a malformed strict settings baseline before POST', async () => {
        get.mockResolvedValue({ ...settingsEnvelope(), version: { epoch: '', revision: -1 } });
        const logic = useSettingsLogic();
        await logic.loadSettings();
        expect(await logic.handleSave()).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });
    it.each([
        { success: true },
        { success: true, subscriptionProtocol: 'd1-v1' },
        {
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: { epoch: 'domain-fixture', revision: -1 },
        },
    ])(
        'does not accept a malformed strict settings success as a new baseline: %j',
        async (response) => {
            get.mockResolvedValue(settingsEnvelope());
            post.mockResolvedValue(response);
            const logic = useSettingsLogic();
            await logic.loadSettings();
            logic.settings.value.FileName = 'unsaved';
            expect(await logic.handleSave()).toBe(false);
            expect(logic.restartCountdown.value).toBeNull();
            expect(logic.settings.value.FileName).toBe('unsaved');
            respond(settingsEnvelope(3));
            expect(await logic.handleSave()).toBe(true);
            expect(post.mock.calls[1][1].baseVersion).toEqual(version(2));
        }
    );
});

describe('independent settings and rule edit baselines', () => {
    it('does not replace the rule or settings baseline with a runtime observation version', async () => {
        const store = loaded();
        post.mockResolvedValueOnce({
            success: true,
            applied: true,
            subscriptionSnapshot: {
                version: version(3),
                subscriptions: [{ ...node, nodeCount: 10 }],
                profiles: [],
            },
        });
        expect((await store.refreshSubscriptionRuntime('one')).success).toBe(true);
        store.ruleTemplates[0].name = 'Unsaved rule';
        respond(
            {
                success: true,
                subscriptionProtocol: 'd1-v1',
                version: version(4),
                data: store.ruleTemplates,
            },
            { once: true }
        );
        await store.saveRuleTemplates();
        expect(post.mock.calls[1][0]).toBe('/api/rule_templates');
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(2));
        respond(
            { success: true, version: version(5), data: { siteName: 'Edited' } },
            { once: true }
        );
        await store.saveSettings({ siteName: 'Edited' });
        expect(post.mock.calls[2][1].baseVersion).toEqual(version(2));
    });
    it('uses an explicit rule GET baseline then advances it only on successful rule save', async () => {
        const store = loaded();
        get.mockResolvedValue({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(7),
            data: [{ id: 'rule', name: 'Fresh', content: 'DOMAIN,fixture.invalid,DIRECT' }],
        });
        await store.fetchRuleTemplates();
        store.ruleTemplates[0].name = 'Edited';
        respond({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(8),
            data: store.ruleTemplates,
        });
        await store.saveRuleTemplates();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(7));
        respond({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: version(9),
            data: store.ruleTemplates,
        });
        await store.saveRuleTemplates();
        expect(post.mock.calls[1][1].baseVersion).toEqual(version(8));
        expect(get).toHaveBeenCalledOnce();
    });
    it('preserves rule edits on 409 and does not adopt a new baseline automatically', async () => {
        const store = loaded();
        store.ruleTemplates[0].name = 'Unsaved';
        post.mockRejectedValue(new APIError('revision_conflict', 409));
        await expect(store.saveRuleTemplates()).rejects.toThrow('revision_conflict');
        expect(store.ruleTemplates[0].name).toBe('Unsaved');
        expect(get).not.toHaveBeenCalled();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(2));
    });
    it('does not assign a malformed rule GET response as a new baseline or clear existing rules', async () => {
        const store = loaded();
        get.mockResolvedValue({
            success: true,
            subscriptionProtocol: 'd1-v1',
            version: { epoch: 'invalid', revision: -1 },
            data: [],
        });
        await expect(store.fetchRuleTemplates()).rejects.toThrow();
        expect(store.ruleTemplates).toHaveLength(1);
        respond({ success: true, version: version(3), data: store.ruleTemplates });
        await store.saveRuleTemplates();
        expect(post.mock.calls[0][1].baseVersion).toEqual(version(2));
    });
    it('keeps legacy rule saves free of strict metadata', async () => {
        const store = useDataStore();
        const legacy = data();
        delete legacy.subscriptionProtocol;
        delete legacy.version;
        store.hydrateFromData(legacy);
        post.mockResolvedValue({ success: true, data: legacy.ruleTemplates });
        await store.saveRuleTemplates();
        expect(post.mock.calls[0][1]).toEqual({ templates: legacy.ruleTemplates });
    });
});
