import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useToastStore } from './toast';
import { useSettingsStore } from './settings';
import { useEditorStore } from './editor';
import { createStorageCache } from '../utils/cache-helper.js';
import { DEFAULT_SETTINGS } from '../constants/default-settings.js';
import { TIMING } from '../constants/timing.js';
import { api } from '../lib/http.js';
import { t } from '../i18n/index.js';
import {
    acknowledgedDomainVersion,
    domainMutationMetadata,
    isStrictSettingsData,
    replayDomainEdits,
    sameDomainData,
    validDomainAcknowledgement,
    validDomainResponse,
} from '../shared/domain-mutation.js';
import {
    buildSubscriptionEditOperations,
    createSubscriptionOperationId,
    editableSubscriptionFields,
    hasObservationConfigurationChange,
    isSubscriptionVersion,
    rebaseSubscriptionEdits,
} from '../shared/subscription-edit-operations.js';

const isDev = import.meta.env.DEV;

// Initialize Cache
const dataCache = createStorageCache('misub_data_cache', TIMING.CACHE_TTL_MS);

const cloneData = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCollection = (value) => Array.isArray(value) && value.every(isRecord);

function validIdentifiedCollection(value) {
    if (!isCollection(value)) return false;
    const ids = new Set();
    return value.every((item) => {
        if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) return false;
        ids.add(item.id);
        return true;
    });
}

function validCollections(data) {
    return (
        isRecord(data) &&
        !data.error &&
        (data.success === undefined || data.success === true) &&
        validIdentifiedCollection(data.misubs) &&
        validIdentifiedCollection(data.profiles)
    );
}

function validLoadedData(data) {
    return (
        validCollections(data) &&
        isCollection(data.ruleTemplates) &&
        isRecord(data.config) &&
        (data.subscriptionProtocol === undefined ||
            data.subscriptionProtocol === 'legacy' ||
            (data.subscriptionProtocol === 'd1-v1' && isSubscriptionVersion(data.version)))
    );
}

function validAcknowledgement(result, request) {
    const receiptVersion = result.receipt?.version;
    const version = result.data?.version;
    return (
        result.receipt?.operationId === request.operationId &&
        isSubscriptionVersion(receiptVersion) &&
        isSubscriptionVersion(version) &&
        receiptVersion.epoch === request.baseVersion.epoch &&
        version.epoch === receiptVersion.epoch &&
        receiptVersion.revision > request.baseVersion.revision &&
        version.revision >= receiptVersion.revision
    );
}

const asSnapshot = (data) => ({ subscriptions: data.misubs, profiles: data.profiles });

export const useDataStore = defineStore('data', () => {
    const { showToast } = useToastStore();
    const settingsStore = useSettingsStore();
    const editorStore = useEditorStore();

    // --- State ---
    const subscriptions = ref([]);
    const profiles = ref([]);
    const ruleTemplates = ref([]);
    const settings = computed(() => settingsStore.config);

    // Store Status
    const isLoading = ref(false);
    const saveState = ref('idle');
    const subscriptionProtocol = ref('legacy');
    const subscriptionConflict = ref(false);
    const lastUpdated = ref(null);
    const hasDataLoaded = computed(() => !!lastUpdated.value);

    // Derived Dirty State (from Editor)
    const isDirty = computed(() => editorStore.isDirty);

    // --- Getters ---
    const activeSubscriptions = computed(() => subscriptions.value.filter((sub) => sub.enabled));
    const activeProfiles = computed(() => profiles.value.filter((profile) => profile.enabled));

    // --- Internal: Snapshot for rollback/diffing ---
    let lastSavedData = {
        subscriptions: [],
        profiles: [],
        ruleTemplates: [],
        config: {},
    };
    let hasAuthoritativeBaseline = false;
    let lifecycle = 0;
    let editVersion = 0;
    let saveSequence = 0;
    let saving = false;
    let snapshotVersion = null;
    let configVersion = null;
    let configGeneration = 0;
    let rulesVersion = null;
    let rulesProtocol = 'legacy';
    let rulesRequest = 0;
    let rulesReadSequence = 0;
    const domainSaves = new Map();
    let pendingSubmission = null;

    // --- Actions ---

    // External hydration receives the complete authenticated /api/data response.
    function hydrateFromData(data, { fromCache = false } = {}) {
        if (!validLoadedData(data)) return false;
        try {
            // Prepare every collection before publishing any state or saved baseline.
            const next = cloneData(data);
            if (!validLoadedData(next)) return false;
            const snapshot = {
                subscriptions: cloneData(next.misubs),
                profiles: cloneData(next.profiles),
                ruleTemplates: cloneData(next.ruleTemplates),
                config: cloneData(next.config),
            };
            subscriptions.value = next.misubs.map((sub) => ({ ...sub, isUpdating: false }));
            profiles.value = next.profiles;
            ruleTemplates.value = next.ruleTemplates;
            settingsStore.setConfig({ ...DEFAULT_SETTINGS, ...next.config });
            if (!fromCache) {
                invalidateRequests();
                lastSavedData = snapshot;
                hasAuthoritativeBaseline = true;
                subscriptionProtocol.value =
                    next.subscriptionProtocol === 'd1-v1' ? 'd1-v1' : 'legacy';
                snapshotVersion =
                    subscriptionProtocol.value === 'd1-v1' ? cloneData(next.version) : null;
                configVersion = snapshotVersion ? { ...snapshotVersion } : null;
                rulesVersion = snapshotVersion ? { ...snapshotVersion } : null;
                rulesProtocol = subscriptionProtocol.value;
                pendingSubmission = null;
                subscriptionConflict.value = false;
                lastUpdated.value = new Date();
                clearDirty();
                dataCache.set(next);
            }
            return true;
        } catch (error) {
            console.error('hydrateFromData failed:', error);
            return false;
        }
    }

    let fetchDataPromise = null;

    async function fetchData(forceRefresh = false) {
        if (fetchDataPromise) return fetchDataPromise;
        if (saving || domainSaves.has('settings')) {
            showToast(t('store.tooFrequent'), 'warning');
            return false;
        }
        if (hasAuthoritativeBaseline && !forceRefresh) return true;

        // Cached collections can be displayed, but only an authoritative load enables saving.
        if (!forceRefresh && !isDirty.value) {
            const cachedData = dataCache.get();
            if (cachedData) hydrateFromData(cachedData, { fromCache: true });
        }

        const request = (async () => {
            isLoading.value = true;
            const requestLifecycle = lifecycle;
            const configRead = settingsReadToken();
            const requestEditVersion = editVersion;
            let startingEditorData;
            try {
                startingEditorData = JSON.stringify(captureEditorData());
                const data = await api.get('/api/data');
                if (requestLifecycle !== lifecycle || !isSettingsReadCurrent(configRead))
                    return false;
                if (!validLoadedData(data)) throw new Error(t('store.invalidDataResponse'));
                if (editorChangedSince(startingEditorData, requestEditVersion)) {
                    throw new Error(t('store.editedDuringLoad'));
                }
                if (!hydrateFromData(data)) throw new Error(t('store.invalidDataResponse'));
                clearDirty();
                return true;
            } catch (error) {
                if (requestLifecycle !== lifecycle) return false;
                if (
                    startingEditorData !== undefined &&
                    editorChangedSince(startingEditorData, requestEditVersion)
                ) {
                    markDirty();
                }
                console.error('Failed to fetch data:', error);
                showToast(t('store.fetchDataFailed', { message: error.message }), 'error');
                return false;
            } finally {
                if (requestLifecycle === lifecycle) isLoading.value = false;
            }
        })();
        fetchDataPromise = request;
        try {
            return await request;
        } finally {
            if (fetchDataPromise === request) fetchDataPromise = null;
        }
    }

    async function saveData() {
        if (isLoading.value) {
            showToast(t('store.tooFrequent'), 'warning');
            return false;
        }
        if (!hasAuthoritativeBaseline) {
            showToast(t('store.saveDataFailed', { message: t('store.loadBeforeSave') }), 'error');
            return false;
        }
        if (subscriptionConflict.value) {
            showToast(t('store.subscriptionConflict'), 'error');
            return false;
        }

        saving = true;
        isLoading.value = true;
        saveState.value = 'saving';
        const requestLifecycle = lifecycle;
        const requestEditVersion = editVersion;
        const requestSequence = ++saveSequence;
        try {
            let submitted = captureEditorData();
            let startingEditorData = JSON.stringify(submitted);
            let submittedEditVersion = requestEditVersion;
            const strict = subscriptionProtocol.value === 'd1-v1';
            let payload = {
                misubs: submitted.misubs,
                profiles: submitted.profiles.map((profile) => {
                    const normalizedProfile = { ...profile };
                    normalizedProfile.ruleLevel =
                        normalizedProfile.ruleLevel || normalizedProfile.clashRuleLevel || '';
                    delete normalizedProfile.clashRuleLevel;
                    return normalizedProfile;
                }),
            };
            if (strict) {
                if (!pendingSubmission) {
                    const operations = buildSubscriptionEditOperations(
                        lastSavedData,
                        asSnapshot(submitted)
                    );
                    if (!operations.length) {
                        clearDirty();
                        return true;
                    }
                    pendingSubmission = {
                        request: {
                            operationId: createSubscriptionOperationId(),
                            baseVersion: cloneData(snapshotVersion),
                            operations,
                        },
                        submitted,
                        serialized: startingEditorData,
                        editVersion: requestEditVersion,
                    };
                }
                submitted = pendingSubmission.submitted;
                startingEditorData = pendingSubmission.serialized;
                submittedEditVersion = pendingSubmission.editVersion;
                payload = cloneData(pendingSubmission.request);
            } else {
                pruneInvalidReferences(payload.profiles, payload.misubs);
            }
            const result = await api.post('/api/misubs', payload);
            if (requestLifecycle !== lifecycle) return false;
            if (result?.success !== true) {
                if (strict && (result?.status === 409 || result?.code?.includes('conflict'))) {
                    subscriptionConflict.value = true;
                }
                throw new Error(result?.message || t('store.saveFailed'));
            }
            if (!validCollections(result.data)) throw new Error(t('store.invalidSaveResponse'));
            const confirmed = cloneData(result.data);
            if (!validCollections(confirmed)) throw new Error(t('store.invalidSaveResponse'));

            let rebased;
            if (strict) {
                if (!validAcknowledgement(result, payload))
                    throw new Error(t('store.invalidSaveResponse'));
                rebased = rebaseSubscriptionEdits(
                    asSnapshot(submitted),
                    asSnapshot(captureEditorData()),
                    {
                        subscriptions: confirmed.misubs,
                        profiles: confirmed.profiles,
                    },
                    { checkConflicts: confirmed.version.revision > result.receipt.version.revision }
                );
                snapshotVersion = cloneData(confirmed.version);
                pendingSubmission = null;
            }

            const editedDuringSave = editorChangedSince(startingEditorData, submittedEditVersion);
            lastSavedData.subscriptions = cloneData(confirmed.misubs);
            lastSavedData.profiles = cloneData(confirmed.profiles);
            if (strict && !rebased) {
                subscriptionConflict.value = true;
                markDirty();
                saveState.value = 'idle';
                showToast(t('store.subscriptionConflict'), 'error');
            } else if (editedDuringSave) {
                if (strict) {
                    subscriptions.value = rebased.subscriptions;
                    profiles.value = rebased.profiles;
                }
                markDirty();
                saveState.value = 'idle';
            } else {
                subscriptions.value = confirmed.misubs.map((sub) => ({
                    ...sub,
                    isUpdating: false,
                }));
                profiles.value = confirmed.profiles;
                clearDirty();
                saveState.value = 'success';
            }
            if (!subscriptionConflict.value) showToast(t('store.dataSaved'), 'success');
            lastUpdated.value = new Date();
            setTimeout(() => {
                if (
                    requestLifecycle === lifecycle &&
                    requestSequence === saveSequence &&
                    saveState.value === 'success'
                ) {
                    saveState.value = 'idle';
                }
            }, 2000);

            // Cache only acknowledged collections, independently of the current editor.
            cacheConfirmedData();
            return !subscriptionConflict.value;
        } catch (error) {
            if (requestLifecycle !== lifecycle) return false;
            if (subscriptionProtocol.value === 'd1-v1' && error?.status === 409) {
                subscriptionConflict.value = true;
            }
            editorStore.markDirty();
            console.error('[Store] Failed to save data:', error);
            showToast(
                subscriptionConflict.value
                    ? t('store.subscriptionConflict')
                    : t('store.saveDataFailed', { message: error.message }),
                'error'
            );
            saveState.value = 'idle';
            return false;
        } finally {
            if (requestLifecycle === lifecycle) {
                saving = false;
                isLoading.value = false;
                if (saveState.value === 'saving') saveState.value = 'idle';
            }
        }
    }

    /**
     * 保存设置（服务端会做 { ...oldSettings, ...newSettings } 合并，
     * 所以可以只传变化的那几个字段）。
     * @param {Object} newSettings
     * @param {{ silent?: boolean, preferencesOnly?: boolean }} [options]
     *        - silent=true 时不弹任何提示，由调用方给出更贴切的文案
     *          （例如「忽略待处理项」不该弹「设置已更新」）。
     *        - preferencesOnly=true 表示这次只改界面偏好：服务端会跳过
     *          「清空节点缓存」和「发 TG 设置更新通知」这两个副作用。
     *          仅当本次载荷确实不影响节点处理时才可传 true。
     *          （请求头名字与 functions/modules/api-handler.js 里的读取一一对应）
     * @returns {Promise<boolean>} 成功时为 true；失败时**抛出**（沿用既有约定，
     *          调用方自行 catch，静默模式下尤其需要）
     */
    async function saveSettings(newSettings, options = {}) {
        const { silent = false, preferencesOnly = false } = options;
        const request = beginDomainSave('settings');
        try {
            const strict = subscriptionProtocol.value === 'd1-v1';
            const metadata = domainMutationMetadata({
                subscriptionProtocol: subscriptionProtocol.value,
                version: configVersion,
            });
            const submitted = cloneData(newSettings);
            const editorAtStart = cloneData(settingsStore.config);
            const confirmedAtStart = cloneData(lastSavedData.config);
            const result = await api.post(
                '/api/settings',
                strict ? { ...metadata, settings: submitted } : submitted,
                preferencesOnly ? { headers: { 'X-MiSub-Save-Scope': 'preferences' } } : {}
            );

            if (!currentDomainSave('settings', request)) return false;
            if (!result?.success) {
                throw new Error(result.message || t('store.saveSettingsFailed'));
            }

            if (!validDomainAcknowledgement(result, metadata, isStrictSettingsData))
                throw new Error(t('store.invalidDataResponse'));
            configGeneration += 1;
            const confirmed = strict
                ? cloneData(result.data)
                : { ...confirmedAtStart, ...submitted };
            const displayed = strict
                ? { ...DEFAULT_SETTINGS, ...confirmed }
                : { ...editorAtStart, ...submitted };
            const intended = replayDomainEdits(editorAtStart, settingsStore.config, {
                ...editorAtStart,
                ...submitted,
            });
            const submittedBaseline = { ...DEFAULT_SETTINGS, ...confirmedAtStart, ...submitted };
            const changed = !sameDomainData(submittedBaseline, intended);
            settingsStore.setConfig(replayDomainEdits(submittedBaseline, intended, displayed));
            if (strict) configVersion = acknowledgedDomainVersion(result, changed);
            syncCachedConfig(confirmed);
            if (!silent) showToast(t('store.settingsUpdated'), 'success');
            return true;
        } catch (error) {
            if (!currentDomainSave('settings', request)) return false;
            console.error('Failed to save settings:', error);
            if (!silent) {
                showToast(
                    t('store.saveSettingsFailedWithMessage', { message: error.message }),
                    'error'
                );
            }
            throw error;
        } finally {
            finishDomainSave('settings', request);
        }
    }

    async function refreshSubscriptionRuntime(id) {
        const saved = lastSavedData.subscriptions.find((item) => item.id === id);
        const current = subscriptions.value.find((item) => item.id === id);
        if (
            subscriptionProtocol.value !== 'd1-v1' ||
            !hasAuthoritativeBaseline ||
            isLoading.value ||
            pendingSubmission ||
            subscriptionConflict.value ||
            !saved ||
            !current ||
            JSON.stringify(editableSubscriptionFields('subscriptions', saved)) !==
                JSON.stringify(editableSubscriptionFields('subscriptions', current))
        ) {
            return {
                success: false,
                error: t('store.runtimeNeedsSavedData'),
                errorType: 'validation',
            };
        }
        const requestLifecycle = lifecycle;
        saving = true;
        isLoading.value = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMING.REQUEST_TIMEOUT_MS);
        try {
            const result = await api.post(
                '/api/node_count',
                {
                    subscriptionId: id,
                    baseVersion: cloneData(snapshotVersion),
                    operationId: createSubscriptionOperationId(),
                },
                { signal: controller.signal }
            );
            if (requestLifecycle !== lifecycle)
                return { success: false, error: t('store.runtimeNeedsSavedData') };
            if (!result?.success || result.applied !== true) {
                return {
                    success: false,
                    error: result?.message || t('store.runtimeNotApplied'),
                    errorType: 'server',
                };
            }
            const confirmed = result.subscriptionSnapshot;
            if (
                !confirmed ||
                !validCollections({
                    misubs: confirmed.subscriptions,
                    profiles: confirmed.profiles,
                }) ||
                !isSubscriptionVersion(confirmed.version) ||
                confirmed.version.epoch !== snapshotVersion.epoch ||
                confirmed.version.revision < snapshotVersion.revision
            ) {
                throw new Error(t('store.invalidDataResponse'));
            }
            const edited = asSnapshot(captureEditorData());
            const targetChanged = hasObservationConfigurationChange(
                saved,
                edited.subscriptions.find((item) => item.id === id)
            );
            const hasEdits = buildSubscriptionEditOperations(lastSavedData, edited).length > 0;
            const rebased = rebaseSubscriptionEdits(lastSavedData, edited, confirmed);
            lastSavedData.subscriptions = cloneData(confirmed.subscriptions);
            lastSavedData.profiles = cloneData(confirmed.profiles);
            snapshotVersion = cloneData(confirmed.version);
            cacheConfirmedData();
            if (!rebased) {
                subscriptionConflict.value = true;
                markDirty();
                return {
                    success: false,
                    error: t('store.subscriptionConflict'),
                    errorType: 'conflict',
                };
            }
            subscriptions.value = rebased.subscriptions;
            profiles.value = rebased.profiles;
            lastUpdated.value = new Date();
            if (hasEdits) markDirty();
            if (targetChanged)
                return {
                    success: false,
                    error: t('store.runtimeNotApplied'),
                    errorType: 'validation',
                };
            const observed = confirmed.subscriptions.find((item) => item.id === id);
            if (!observed)
                return {
                    success: false,
                    error: t('store.runtimeNeedsSavedData'),
                    errorType: 'conflict',
                };
            return {
                success: true,
                data: { count: observed.nodeCount || 0, userInfo: observed.userInfo || null },
                applied: true,
            };
        } catch (error) {
            if (requestLifecycle === lifecycle && error?.status === 409)
                subscriptionConflict.value = true;
            return {
                success: false,
                error: subscriptionConflict.value ? t('store.subscriptionConflict') : error.message,
                errorType: error?.status === 409 ? 'conflict' : 'server',
            };
        } finally {
            clearTimeout(timeout);
            if (requestLifecycle === lifecycle) {
                saving = false;
                isLoading.value = false;
            }
        }
    }

    // Keep successful settings edits visible even when navigating before a scheduled reload.
    function applySavedSettings(request, newSettings, acknowledgement = null) {
        if (!isSettingsSaveCurrent(request)) return false;
        configGeneration += 1;
        settingsStore.updateConfig(newSettings);
        if (acknowledgement?.subscriptionProtocol === 'd1-v1')
            configVersion = cloneData(acknowledgement.version);
        syncCachedConfig(settingsStore.config);
        return true;
    }

    function settingsReadToken() {
        return { lifecycle, generation: configGeneration, readable: !domainSaves.has('settings') };
    }
    function isSettingsReadCurrent(token) {
        return (
            token.readable &&
            token.lifecycle === lifecycle &&
            token.generation === configGeneration &&
            !domainSaves.has('settings')
        );
    }
    const beginSettingsSave = () => beginDomainSave('settings');
    const isSettingsSaveCurrent = (request) => currentDomainSave('settings', request);
    const finishSettingsSave = (request) => {
        if (request) finishDomainSave('settings', request);
    };

    async function fetchRuleTemplates() {
        const sequence = ++rulesReadSequence;
        const requestGeneration = rulesRequest;
        const requestLifecycle = lifecycle;
        const editorAtStart = cloneData(ruleTemplates.value);
        const result = await api.get('/api/rule_templates');
        if (
            requestLifecycle !== lifecycle ||
            sequence !== rulesReadSequence ||
            requestGeneration !== rulesRequest
        )
            return false;
        if (!sameDomainData(editorAtStart, ruleTemplates.value)) return false;
        if (
            !validDomainResponse(result, validIdentifiedCollection, {
                strict: rulesProtocol === 'd1-v1',
            })
        )
            throw new Error(t('store.invalidDataResponse'));
        ruleTemplates.value = cloneData(result.data);
        rulesRequest += 1;
        rulesProtocol = result.subscriptionProtocol === 'd1-v1' ? 'd1-v1' : 'legacy';
        rulesVersion = result.subscriptionProtocol === 'd1-v1' ? { ...result.version } : null;
        lastSavedData.ruleTemplates = JSON.parse(JSON.stringify(ruleTemplates.value));
        return ruleTemplates.value;
    }

    async function saveRuleTemplates(items = ruleTemplates.value) {
        const request = beginDomainSave('rules');
        const sequence = ++rulesRequest;
        try {
            const strict = rulesProtocol === 'd1-v1';
            const metadata = domainMutationMetadata({
                subscriptionProtocol: rulesProtocol,
                version: rulesVersion,
            });
            const submitted = cloneData(items);
            const editorAtStart = cloneData(ruleTemplates.value);
            const result = await api.post('/api/rule_templates', {
                templates: submitted,
                ...metadata,
            });
            if (!currentDomainSave('rules', request) || sequence !== rulesRequest) return false;
            if (!result?.success) {
                throw new Error(result.message || t('store.saveRuleTemplatesFailed'));
            }
            if (
                !validIdentifiedCollection(result.data) ||
                !validDomainAcknowledgement(result, metadata, validIdentifiedCollection)
            )
                throw new Error(t('store.invalidDataResponse'));
            const changed = !sameDomainData(editorAtStart, ruleTemplates.value);
            rulesVersion = strict ? acknowledgedDomainVersion(result, changed) : null;
            ruleTemplates.value = replayDomainEdits(
                editorAtStart,
                ruleTemplates.value,
                result.data
            );
            lastSavedData.ruleTemplates = cloneData(result.data);
            if (changed) editorStore.markDirty();
            const cached = dataCache.get();
            if (cached) dataCache.set({ ...cached, ruleTemplates: cloneData(result.data) });
            rulesRequest += 1;
            showToast(t('store.ruleTemplatesSaved'), 'success');
            return ruleTemplates.value;
        } catch (error) {
            if (!currentDomainSave('rules', request) || sequence !== rulesRequest) return false;
            console.error('Failed to save rule templates:', error);
            showToast(
                t('store.saveRuleTemplatesFailedWithMessage', { message: error.message }),
                'error'
            );
            throw error;
        } finally {
            finishDomainSave('rules', request);
        }
    }

    // --- Helpers ---

    function invalidateDomainRequests() {
        rulesRequest += 1;
        domainSaves.clear();
        editorStore.setLoading(false);
    }

    function beginDomainSave(domain) {
        if (domainSaves.has(domain)) throw new Error(t('store.tooFrequent'));
        if (domain === 'settings') configGeneration += 1;
        const request = { lifecycle };
        domainSaves.set(domain, request);
        editorStore.setLoading(true);
        return request;
    }

    function currentDomainSave(domain, request) {
        return request.lifecycle === lifecycle && domainSaves.get(domain) === request;
    }

    function finishDomainSave(domain, request) {
        if (!currentDomainSave(domain, request)) return;
        domainSaves.delete(domain);
        editorStore.setLoading(domainSaves.size > 0);
    }

    function captureEditorData() {
        return {
            misubs: cloneData(subscriptions.value.map(({ isUpdating, ...sub }) => sub)),
            profiles: cloneData(profiles.value),
            ruleTemplates: cloneData(ruleTemplates.value),
        };
    }

    function editorChangedSince(serializedData, version) {
        if (editVersion !== version) return true;
        try {
            return serializedData !== JSON.stringify(captureEditorData());
        } catch {
            return true;
        }
    }

    function invalidateRequests() {
        lifecycle += 1;
        configGeneration += 1;
        invalidateDomainRequests();
        fetchDataPromise = null;
        saveSequence += 1;
        saving = false;
        isLoading.value = false;
        saveState.value = 'idle';
    }

    function clearCachedData() {
        invalidateRequests();
        subscriptions.value = [];
        profiles.value = [];
        ruleTemplates.value = [];
        settingsStore.setConfig({ ...DEFAULT_SETTINGS });
        lastSavedData = { subscriptions: [], profiles: [], ruleTemplates: [], config: {} };
        clearDirty();
        editorStore.setLastUpdated(null);
        hasAuthoritativeBaseline = false;
        subscriptionProtocol.value = 'legacy';
        subscriptionConflict.value = false;
        snapshotVersion = null;
        configVersion = null;
        rulesVersion = null;
        rulesProtocol = 'legacy';
        pendingSubmission = null;
        lastUpdated.value = null;
        dataCache.clear();
    }

    function cacheConfirmedData() {
        dataCache.set({
            misubs: lastSavedData.subscriptions,
            profiles: lastSavedData.profiles,
            ruleTemplates: lastSavedData.ruleTemplates,
            config: lastSavedData.config,
            ...(subscriptionProtocol.value === 'd1-v1'
                ? {
                      subscriptionProtocol: 'd1-v1',
                      version: cloneData(snapshotVersion),
                  }
                : {}),
        });
    }

    function isSavedNode(node) {
        return Boolean(
            hasAuthoritativeBaseline &&
            node &&
            lastSavedData.subscriptions.some(
                (saved) => saved.id === node.id && saved.url === node.url
            )
        );
    }

    function syncCachedConfig(nextConfig) {
        lastSavedData.config = cloneData(nextConfig);
        const cachedData = dataCache.get();
        if (!cachedData) return;

        dataCache.set({
            ...cachedData,
            config: cloneData(nextConfig),
        });
    }

    // --- Proxy Actions (Mutators) ---
    function addSubscription(subscription) {
        subscriptions.value.unshift(subscription);
        markDirty();
    }

    function overwriteSubscriptions(items) {
        subscriptions.value = items;
    }

    function removeSubscription(id) {
        const index = subscriptions.value.findIndex((s) => s.id === id);
        if (index !== -1) {
            subscriptions.value.splice(index, 1);
        }
    }

    function updateSubscription(id, updates) {
        const index = subscriptions.value.findIndex((s) => s.id === id);
        if (index !== -1) {
            subscriptions.value[index] = { ...subscriptions.value[index], ...updates };
            markDirty();
        }
    }

    function addProfile(profile) {
        profiles.value.unshift(profile);
    }

    function overwriteProfiles(items) {
        profiles.value = items;
    }

    function removeProfile(id) {
        const index = profiles.value.findIndex((p) => p.id === id || p.customId === id);
        if (index !== -1) {
            profiles.value.splice(index, 1);
        }
    }

    function removeManualNodeFromProfiles(nodeIds) {
        const idsToRemove = Array.isArray(nodeIds) ? new Set(nodeIds) : new Set([nodeIds]);
        if (idsToRemove.size === 0) return;

        let modified = false;
        profiles.value.forEach((profile) => {
            if (Array.isArray(profile.manualNodes) && profile.manualNodes.length > 0) {
                const originalLength = profile.manualNodes.length;
                profile.manualNodes = profile.manualNodes.filter((id) => !idsToRemove.has(id));
                if (profile.manualNodes.length !== originalLength) {
                    modified = true;
                }
            }
        });

        if (modified) {
            profiles.value = [...profiles.value]; // 强制触发响应式更新
            if (isDev) {
                console.debug('[DataStore] Cleaned up manual node references from profiles');
            }
        }
    }

    function removeSubscriptionFromProfiles(subIds) {
        const idsToRemove = Array.isArray(subIds) ? new Set(subIds) : new Set([subIds]);
        if (idsToRemove.size === 0) return;

        let modified = false;
        profiles.value.forEach((profile) => {
            if (Array.isArray(profile.subscriptions) && profile.subscriptions.length > 0) {
                const originalLength = profile.subscriptions.length;
                profile.subscriptions = profile.subscriptions.filter((id) => !idsToRemove.has(id));
                if (profile.subscriptions.length !== originalLength) {
                    modified = true;
                }
            }
        });

        if (modified) {
            profiles.value = [...profiles.value]; // 强制触发响应式更新
            if (isDev) {
                console.debug('[DataStore] Cleaned up subscription references from profiles');
            }
        }
    }

    /**
     * 数据自愈：清理订阅组中不存在的节点/订阅引用
     * 同时处理可能存在的重复 ID
     */
    function pruneInvalidReferences(items, subscriptionsToSave) {
        const validIds = new Set(subscriptionsToSave.map((item) => item.id));
        for (const profile of items) {
            for (const field of ['manualNodes', 'subscriptions']) {
                if (!Array.isArray(profile[field])) continue;
                const seenIds = new Set();
                profile[field] = profile[field].filter((id) => {
                    if (!validIds.has(id) || seenIds.has(id)) return false;
                    seenIds.add(id);
                    return true;
                });
            }
        }
    }

    // --- Dirty State Proxies ---
    function markDirty() {
        editVersion += 1;
        if (saveState.value === 'success') {
            saveState.value = 'idle';
        }
        editorStore.markDirty();
    }

    function clearDirty() {
        editorStore.clearDirty();
    }

    return {
        // State
        subscriptions,
        profiles,
        ruleTemplates,
        settings,
        isLoading,
        saveState,
        subscriptionProtocol,
        subscriptionConflict,
        lastUpdated,
        hasDataLoaded,
        isDirty,

        // Getters
        activeSubscriptions,
        activeProfiles,

        // Actions
        fetchData,
        saveData,
        refreshSubscriptionRuntime,
        saveSettings,
        applySavedSettings,
        beginSettingsSave,
        isSettingsSaveCurrent,
        finishSettingsSave,
        settingsReadToken,
        isSettingsReadCurrent,
        fetchRuleTemplates,
        saveRuleTemplates,
        hydrateFromData,
        isSavedNode,
        clearCachedData,

        // Helpers
        addSubscription,
        overwriteSubscriptions,
        removeSubscription,
        updateSubscription,
        addProfile,
        overwriteProfiles,
        removeProfile,
        removeManualNodeFromProfiles,
        removeSubscriptionFromProfiles,
        markDirty,
        clearDirty,
    };
});
