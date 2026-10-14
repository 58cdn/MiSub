import { ref } from 'vue';
import { defineStore } from 'pinia';
import router from '../router';
import { fetchInitialData, login as apiLogin, fetchPublicConfig } from '../lib/api';
import { api } from '../lib/http.js';
import { advanceSessionGeneration, currentSessionGeneration } from '../lib/session-generation.js';
import { handleError } from '../utils/errorHandler.js';
import { useDataStore } from './useDataStore';
import { t } from '../i18n/index.js';

export const useSessionStore = defineStore('session', () => {
    const sessionState = ref('loading'); // loading, loggedIn, loggedOut
    const initialData = ref(null);
    const subscriptionConfig = ref({});
    const securityWarning = ref(null);
    const loginSecurity = ref(null);
    const defaultPublicConfig = Object.freeze({
        enablePublicPage: true,
        isLoginPath: false,
        customLoginPath: 'login',
        customPage: {
            enabled: false,
            useDefaultLayout: true,
            allowExternalStylesheets: false,
            allowScripts: false,
            hideBranding: false,
            hideHeader: false,
            hideFooter: false,
        },
    });

    const disabledPublicConfig = Object.freeze({
        ...defaultPublicConfig,
        enablePublicPage: false,
    });

    const publicConfig = ref({
        ...defaultPublicConfig,
        customPage: { ...defaultPublicConfig.customPage },
    }); // Default true until fetched
    const hasLoadedPublicConfig = ref(false);
    let checkSequence = 0;

    function clearSession() {
        advanceSessionGeneration();
        sessionState.value = 'loggedOut';
        initialData.value = null;
        subscriptionConfig.value = {};
        securityWarning.value = null;
        loginSecurity.value = null;
        useDataStore().clearCachedData();
    }

    async function checkSession() {
        const generation = currentSessionGeneration();
        const sequence = ++checkSequence;
        const isCurrent = () =>
            generation === currentSessionGeneration() && sequence === checkSequence;
        // Parallel fetch of initial data (auth check) and public config
        const [dataResult, pConfigResult] = await Promise.all([
            fetchInitialData({ shouldHandleUnauthorized: isCurrent }),
            fetchPublicConfig({ shouldHandleUnauthorized: isCurrent }),
        ]);
        if (generation !== currentSessionGeneration() || sequence !== checkSequence) return null;

        // Update public config
        if (pConfigResult.success) {
            publicConfig.value = pConfigResult.data;
            hasLoadedPublicConfig.value = true;
        } else if (!hasLoadedPublicConfig.value) {
            // Fail closed on the first load; preserve a known-good config on later retries.
            publicConfig.value = {
                ...disabledPublicConfig,
                customPage: { ...disabledPublicConfig.customPage },
            };
        }

        if (dataResult.success && useDataStore().hydrateFromData(dataResult.data)) {
            initialData.value = dataResult.data;
            if (dataResult.data.config) {
                subscriptionConfig.value = dataResult.data.config;
            }

            sessionState.value = 'loggedIn';
            return true;
        } else {
            // Auth failed or other error
            if (dataResult.errorType === 'auth') {
                clearSession();
            } else {
                // Network or other error, still show logged out
                console.error('Session check failed:', dataResult.error);
                handleError(
                    new Error(dataResult.error || t('settings.sessionCheckFailed')),
                    t('settings.sessionCheckContext'),
                    {
                        errorType: dataResult.errorType,
                    }
                );
                clearSession();
            }
            return false;
        }
    }

    async function login(password) {
        const generation = advanceSessionGeneration();
        const result = await apiLogin(password);
        if (generation !== currentSessionGeneration()) return false;
        if (result.success) {
            securityWarning.value = result.data?.securityWarning || null;
            loginSecurity.value = result.data?.loginSecurity || null;
            sessionState.value = 'loading';
            const authenticated = await checkSession();
            if (
                authenticated === null ||
                (authenticated && generation !== currentSessionGeneration())
            )
                return false;
            if (!authenticated) {
                throw new Error(t('settings.sessionCheckFailed'));
            }
            // 登录成功后跳转到仪表盘
            await router.push({ path: '/dashboard' });
        } else {
            const error = new Error(result.error || t('settings.loginFailed'));
            error.status = result.status;
            error.data = result.data;
            throw error;
        }
    }

    async function handleUnauthorized() {
        if (sessionState.value !== 'loggedIn') return false;
        clearSession();
        return true;
    }

    async function logout() {
        const generation = advanceSessionGeneration();
        let logoutConfirmed = false;
        try {
            await api.get('/api/logout');
            logoutConfirmed = true;
        } catch (error) {
            if (generation !== currentSessionGeneration()) return false;
            console.warn('Logout request failed:', error);
        }
        if (generation !== currentSessionGeneration()) return false;

        if (!logoutConfirmed) {
            const sessionCheck = await fetchInitialData();
            if (generation !== currentSessionGeneration()) return false;
            if (sessionCheck.success || sessionCheck.errorType !== 'auth') {
                sessionState.value = 'loggedIn';
                handleError(new Error(t('settings.logoutFailed')), t('settings.logoutContext'), {
                    errorType: 'logout_failed',
                });
                return false;
            }
        }

        clearSession();

        // 跳转到首页（公开页）
        router.push({ path: '/' });
    }

    return {
        sessionState,
        initialData,
        publicConfig,
        subscriptionConfig,
        securityWarning,
        loginSecurity,
        checkSession,
        handleUnauthorized,
        login,
        logout,
    };
});
