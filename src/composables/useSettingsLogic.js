import { ref, computed, onUnmounted, getCurrentInstance } from 'vue';
import { useToastStore } from '../stores/toast.js';
import { DEFAULT_SETTINGS } from '../constants/default-settings.js';
import { fetchSettings, saveSettings, resetSettings } from '../lib/api.js';
import { useBackupLogic } from './useBackupLogic.js';
import { t, setLocale } from '../i18n/index.js';
import { confirmAction } from './useConfirm.js';
import {
    acknowledgedDomainVersion,
    cloneDomainData,
    domainMutationMetadata,
    isDomainRecord,
    isStrictSettingsData,
    replayDomainEdits,
    sameDomainData,
    validDomainAcknowledgement,
    validDomainResponse,
} from '../shared/domain-mutation.js';

function normalizeExternalApiConfig(value) {
    const defaults = DEFAULT_SETTINGS.externalApi;
    const externalApi = value && typeof value === 'object' ? value : {};
    const tokens = Array.isArray(externalApi.tokens)
        ? externalApi.tokens
              .map((item, index) => ({
                  name: String(item?.name || `token-${index + 1}`).trim() || `token-${index + 1}`,
                  token: String(item?.token || '').trim(),
              }))
              .filter((item) => item.token || item.name)
        : [];

    return {
        ...defaults,
        ...externalApi,
        tokens: tokens.length > 0 ? tokens : defaults.tokens.map((item) => ({ ...item })),
    };
}

function normalizeSettingsObject(source = {}) {
    const merged = cloneDomainData({ ...DEFAULT_SETTINGS, ...source });
    merged.externalApi = normalizeExternalApiConfig(source.externalApi ?? merged.externalApi);
    return merged;
}

/**
 * 设置页面的核心逻辑 composable
 * 用于 SettingsView.vue 和 SettingsPanel.vue 的代码复用
 */
export function useSettingsLogic() {
    const { showToast } = useToastStore();

    // 使用备份 composable
    const { exportBackup, importBackup } = useBackupLogic();

    // ========== 状态定义 ==========
    const settings = ref(normalizeSettingsObject(DEFAULT_SETTINGS));
    const isLoading = ref(false);
    const isSaving = ref(false);
    const showMigrationModal = ref(false);
    const restartCountdown = ref(null);
    let reloadTimer = null;
    let settingsBaseline = null;
    let lifecycle = 0;
    let loadSequence = 0;
    let saveRequest = null;
    let disposed = false;

    const clearReloadTimer = () => {
        if (reloadTimer !== null) {
            clearInterval(reloadTimer);
            reloadTimer = null;
        }
    };

    if (getCurrentInstance()) {
        onUnmounted(() => {
            disposed = true;
            lifecycle += 1;
            clearReloadTimer();
        });
    }

    // 嵌套配置对象
    const disguiseConfig = ref({
        enabled: false,
        pageType: 'default',
        redirectUrl: '',
    });

    const editorSnapshot = () =>
        cloneDomainData({ settings: settings.value, disguise: disguiseConfig.value });
    const currentSave = (request) =>
        !disposed && saveRequest === request && request.lifecycle === lifecycle;
    const applySettings = (incoming) => {
        settings.value = normalizeSettingsObject(incoming);
        disguiseConfig.value = {
            enabled: settings.value.disguise?.enabled ?? false,
            pageType: settings.value.disguise?.pageType ?? 'default',
            redirectUrl: settings.value.disguise?.redirectUrl ?? '',
        };
    };

    // ========== 计算属性 ==========
    const hasWhitespace = computed(() => {
        const fieldsCheck = [
            'FileName',
            'mytoken',
            'profileToken',
            'transformConfig',
            'BotToken',
            'ChatID',
        ];
        for (const key of fieldsCheck) {
            if (settings.value[key] && /\s/.test(settings.value[key])) return true;
        }
        return false;
    });

    const isStorageTypeValid = computed(() => ['kv', 'd1'].includes(settings.value.storageType));

    // ========== 核心函数 ==========

    /**
     * 从 API 加载设置
     */
    const loadSettings = async () => {
        const sequence = ++loadSequence;
        const requestLifecycle = lifecycle;
        const editorAtStart = editorSnapshot();
        const currentLoad = () =>
            !disposed && sequence === loadSequence && requestLifecycle === lifecycle;
        isLoading.value = true;
        try {
            const result = await fetchSettings();
            if (!currentLoad() || !sameDomainData(editorAtStart, editorSnapshot())) return false;
            if (
                validDomainResponse(
                    result,
                    result?.subscriptionProtocol === 'd1-v1'
                        ? isStrictSettingsData
                        : isDomainRecord,
                    {
                        strict: settingsBaseline?.subscriptionProtocol === 'd1-v1',
                    }
                )
            ) {
                settingsBaseline = cloneDomainData(result);
                applySettings(result.data);
                lifecycle += 1;
                saveRequest = null;
                isSaving.value = false;
                clearReloadTimer();
                restartCountdown.value = null;

                if (!settings.value.storageType) {
                    settings.value.storageType = 'kv';
                }

                // 应用默认显示语言设置
                if (settings.value.defaultLocale) {
                    setLocale(settings.value.defaultLocale);
                }
                return true;
            } else {
                showToast(t('settings.loadFailed'), 'error');
                return false;
            }
        } catch (error) {
            if (!currentLoad()) return false;
            showToast(t('settings.loadFailed'), 'error');
            return false;
        } finally {
            if (sequence === loadSequence && !disposed) isLoading.value = false;
        }
    };

    /**
     * 保存设置到 API
     */
    const handleSave = async () => {
        if (isSaving.value || disposed) return false;
        if (!settingsBaseline) {
            showToast(t('settings.loadFailed'), 'error');
            return false;
        }
        if (hasWhitespace.value) {
            showToast(t('settings.noWhitespace'), 'error');
            return false;
        }
        if (!isStorageTypeValid.value) {
            showToast(t('settings.invalidStorageType'), 'error');
            return false;
        }

        const request = { lifecycle };
        saveRequest = request;
        loadSequence += 1;
        isLoading.value = false;
        isSaving.value = true;
        clearReloadTimer();
        restartCountdown.value = null;
        try {
            if (!settings.value.storageType) settings.value.storageType = 'kv';
            settings.value.externalApi = normalizeExternalApiConfig(settings.value.externalApi);

            const settingsToSave = cloneDomainData({
                ...settings.value,
                externalApi: normalizeExternalApiConfig(settings.value.externalApi),
                disguise: disguiseConfig.value,
            });
            const editorAtStart = editorSnapshot();

            settingsToSave.ruleLevel =
                settingsToSave.ruleLevel || settingsToSave.clashRuleLevel || 'std';

            delete settingsToSave.prefixConfig;
            delete settingsToSave.prependSubName;
            delete settingsToSave.nodeTransform;
            delete settingsToSave.clashRuleLevel;

            const metadata = domainMutationMetadata(settingsBaseline);
            const result = await saveSettings(settingsToSave, metadata);
            if (!currentSave(request)) return false;
            if (validDomainAcknowledgement(result, metadata, isStrictSettingsData)) {
                loadSequence += 1;
                isLoading.value = false;
                const edited = !sameDomainData(editorAtStart, editorSnapshot());
                const confirmed = metadata.baseVersion
                    ? cloneDomainData(result.data)
                    : settingsToSave;
                const current = editorSnapshot();
                applySettings(confirmed);
                const rebased = replayDomainEdits(editorAtStart, current, editorSnapshot());
                settings.value = rebased.settings;
                disguiseConfig.value = rebased.disguise;
                settingsBaseline = metadata.baseVersion
                    ? {
                          ...cloneDomainData(result),
                          version: acknowledgedDomainVersion(result, edited),
                      }
                    : { success: true, data: cloneDomainData(confirmed) };
                if (edited) return true;
                showToast(t('settings.savedReloading'), 'success');
                clearReloadTimer();
                const confirmedEditor = editorSnapshot();
                restartCountdown.value = 3;
                reloadTimer = setInterval(() => {
                    if (
                        disposed ||
                        lifecycle !== request.lifecycle ||
                        !sameDomainData(confirmedEditor, editorSnapshot())
                    ) {
                        clearReloadTimer();
                        restartCountdown.value = null;
                        return;
                    }
                    restartCountdown.value -= 1;
                    if (restartCountdown.value <= 0) {
                        clearReloadTimer();
                        window.location.reload();
                    }
                }, 1000);
                return true;
            } else {
                throw new Error(result?.error || t('settings.saveFailed'));
            }
        } catch (error) {
            if (!currentSave(request)) return false;
            showToast(error.message, 'error');
            return false;
        } finally {
            if (currentSave(request)) {
                isSaving.value = false;
                saveRequest = null;
            }
        }
    };

    /**
     * 处理 D1 迁移成功
     */
    const handleMigrationSuccess = () => {
        showMigrationModal.value = false;
        settings.value.storageType = 'd1';
        showToast(t('settings.migrationSuccess'), 'success');
    };

    /**
     * 处理恢复出厂设置
     */
    const handleReset = async () => {
        if (!settingsBaseline || disposed || isSaving.value) {
            showToast(t('settings.loadFailed'), 'error');
            return;
        }
        const metadata = domainMutationMetadata(settingsBaseline);
        const requestLifecycle = lifecycle;
        const firstConfirmed = await confirmAction({
            message: t('settings.resetConfirm'),
            variant: 'danger',
        });
        if (!firstConfirmed || disposed || requestLifecycle !== lifecycle) {
            return;
        }

        const secondConfirmed = await confirmAction({
            message: t('settings.resetConfirmAgain'),
            variant: 'danger',
        });
        if (!secondConfirmed || disposed || requestLifecycle !== lifecycle || isSaving.value) {
            return;
        }

        const request = { lifecycle };
        saveRequest = request;
        loadSequence += 1;
        isLoading.value = true;
        isSaving.value = true;
        try {
            const result = await resetSettings(metadata);
            if (!currentSave(request)) return false;
            if (validDomainAcknowledgement(result, metadata, isStrictSettingsData)) {
                loadSequence += 1;
                showToast(t('settings.resetSuccess'), 'success');
                const editorAtAck = editorSnapshot();
                setTimeout(() => {
                    if (
                        !disposed &&
                        lifecycle === requestLifecycle &&
                        sameDomainData(editorAtAck, editorSnapshot())
                    )
                        window.location.reload();
                }, 1500);
            } else {
                showToast(t('settings.resetFailedWithMessage', { message: result.error }), 'error');
            }
        } catch (error) {
            if (!currentSave(request)) return false;
            showToast(t('settings.resetRequestFailed'), 'error');
        } finally {
            if (currentSave(request)) {
                isLoading.value = false;
                isSaving.value = false;
                saveRequest = null;
            }
        }
    };

    return {
        settings,
        disguiseConfig,
        isLoading,
        isSaving,
        showMigrationModal,
        restartCountdown,
        hasWhitespace,
        isStorageTypeValid,
        loadSettings,
        handleSave,
        handleMigrationSuccess,
        handleReset,
        exportBackup,
        importBackup,
    };
}
