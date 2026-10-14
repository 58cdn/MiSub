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
    return validCollections(data) && isCollection(data.ruleTemplates) && isRecord(data.config);
}

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
                lifecycle += 1;
                lastSavedData = snapshot;
                hasAuthoritativeBaseline = true;
                lastUpdated.value = new Date();
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
        if (saving) {
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
            const requestEditVersion = editVersion;
            let startingEditorData;
            try {
                startingEditorData = JSON.stringify(captureEditorData());
                const data = await api.get('/api/data');
                if (requestLifecycle !== lifecycle) return false;
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
                isLoading.value = false;
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

        saving = true;
        isLoading.value = true;
        saveState.value = 'saving';
        const requestLifecycle = lifecycle;
        const requestEditVersion = editVersion;
        const requestSequence = ++saveSequence;
        try {
            const submitted = captureEditorData();
            const startingEditorData = JSON.stringify(submitted);
            const payload = {
                misubs: submitted.misubs,
                profiles: submitted.profiles.map((profile) => {
                    const normalizedProfile = { ...profile };
                    normalizedProfile.ruleLevel =
                        normalizedProfile.ruleLevel || normalizedProfile.clashRuleLevel || '';
                    delete normalizedProfile.clashRuleLevel;
                    return normalizedProfile;
                }),
            };
            pruneInvalidReferences(payload.profiles, payload.misubs);
            const result = await api.post('/api/misubs', payload);
            if (requestLifecycle !== lifecycle) return false;
            if (result?.success !== true) {
                throw new Error(result?.message || t('store.saveFailed'));
            }
            if (!validCollections(result.data)) throw new Error(t('store.invalidSaveResponse'));
            const confirmed = cloneData(result.data);
            if (!validCollections(confirmed)) throw new Error(t('store.invalidSaveResponse'));

            const editedDuringSave = editorChangedSince(startingEditorData, requestEditVersion);
            lastSavedData.subscriptions = cloneData(confirmed.misubs);
            lastSavedData.profiles = cloneData(confirmed.profiles);
            if (editedDuringSave) {
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
            showToast(t('store.dataSaved'), 'success');
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
            dataCache.set({
                misubs: lastSavedData.subscriptions,
                profiles: lastSavedData.profiles,
                ruleTemplates: lastSavedData.ruleTemplates,
                config: lastSavedData.config,
            });
            return true;
        } catch (error) {
            if (requestLifecycle !== lifecycle) return false;
            markDirty();
            console.error('[Store] Failed to save data:', error);
            showToast(t('store.saveDataFailed', { message: error.message }), 'error');
            saveState.value = 'idle';
            return false;
        } finally {
            saving = false;
            isLoading.value = false;
            if (saveState.value === 'saving') saveState.value = 'idle';
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
        editorStore.setLoading(true);
        try {
            const result = await api.post(
                '/api/settings',
                newSettings,
                preferencesOnly ? { headers: { 'X-MiSub-Save-Scope': 'preferences' } } : {}
            );

            if (!result.success) {
                throw new Error(result.message || t('store.saveSettingsFailed'));
            }

            applySavedSettings(newSettings);
            if (!silent) showToast(t('store.settingsUpdated'), 'success');
            return true;
        } catch (error) {
            console.error('Failed to save settings:', error);
            if (!silent) {
                showToast(
                    t('store.saveSettingsFailedWithMessage', { message: error.message }),
                    'error'
                );
            }
            throw error;
        } finally {
            editorStore.setLoading(false);
        }
    }

    // Keep successful settings edits visible even when navigating before a scheduled reload.
    function applySavedSettings(newSettings) {
        settingsStore.updateConfig(newSettings);
        syncCachedConfig(settingsStore.config);
    }

    async function fetchRuleTemplates() {
        const result = await api.get('/api/rule_templates');
        ruleTemplates.value = Array.isArray(result?.data) ? result.data : [];
        lastSavedData.ruleTemplates = JSON.parse(JSON.stringify(ruleTemplates.value));
        return ruleTemplates.value;
    }

    async function saveRuleTemplates(items = ruleTemplates.value) {
        editorStore.setLoading(true);
        try {
            const result = await api.post('/api/rule_templates', { templates: items });
            if (!result.success) {
                throw new Error(result.message || t('store.saveRuleTemplatesFailed'));
            }
            ruleTemplates.value = Array.isArray(result.data) ? result.data : [];
            lastSavedData.ruleTemplates = JSON.parse(JSON.stringify(ruleTemplates.value));
            showToast(t('store.ruleTemplatesSaved'), 'success');
            return ruleTemplates.value;
        } catch (error) {
            console.error('Failed to save rule templates:', error);
            showToast(
                t('store.saveRuleTemplatesFailedWithMessage', { message: error.message }),
                'error'
            );
            throw error;
        } finally {
            editorStore.setLoading(false);
        }
    }

    // --- Helpers ---

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

    function clearCachedData() {
        lifecycle += 1;
        hasAuthoritativeBaseline = false;
        lastUpdated.value = null;
        dataCache.clear();
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
            config: {
                ...(cachedData.config || {}),
                ...(nextConfig || {}),
            },
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
        lastUpdated,
        hasDataLoaded,
        isDirty,

        // Getters
        activeSubscriptions,
        activeProfiles,

        // Actions
        fetchData,
        saveData,
        saveSettings,
        applySavedSettings,
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
