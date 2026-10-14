import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const apiMocks = vi.hoisted(() => ({
    fetchInitialData: vi.fn(),
    fetchPublicConfig: vi.fn(),
    login: vi.fn(),
    apiGet: vi.fn(),
}));

vi.mock('../../src/lib/api', () => apiMocks);
vi.mock('../../src/lib/http.js', () => ({
    api: { get: apiMocks.apiGet },
}));
vi.mock('../../src/router', () => ({
    default: { push: vi.fn() },
}));
vi.mock('../../src/utils/errorHandler.js', () => ({
    handleError: vi.fn(),
}));

describe('session store resilience', () => {
    it('preserves lockout metadata for the login form', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();
        apiMocks.login.mockResolvedValue({
            success: false,
            status: 429,
            data: { code: 'login_locked', retryAfter: 600 },
            error: 'locked',
        });
        await expect(store.login('fixture')).rejects.toMatchObject({
            status: 429,
            data: { code: 'login_locked', retryAfter: 600 },
        });
    });
    it('keeps login security warning alongside the default-password warning and clears it on logout', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();
        apiMocks.login.mockResolvedValue({
            success: true,
            data: {
                securityWarning: { type: 'default_admin_password' },
                loginSecurity: { enabled: true, warning: { id: 42, failedAttempts: 10 } },
            },
        });
        apiMocks.fetchInitialData.mockResolvedValue({
            success: true,
            data: { misubs: [], profiles: [], ruleTemplates: [], config: {} },
        });
        apiMocks.fetchPublicConfig.mockResolvedValue({ success: true, data: {} });
        await store.login('fixture');
        expect(store.loginSecurity.warning.id).toBe(42);
        expect(store.securityWarning.type).toBe('default_admin_password');
        await store.handleUnauthorized();
        expect(store.loginSecurity).toBeNull();
    });
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    it('falls back to the default login entry when public config cannot be fetched', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();

        apiMocks.fetchInitialData.mockResolvedValue({
            success: false,
            error: '认证失败,请重新登录',
            errorType: 'auth',
        });
        apiMocks.fetchPublicConfig.mockResolvedValue({
            success: false,
            error: 'HTTP 500',
            errorType: 'server',
        });

        await store.checkSession();

        expect(store.sessionState).toBe('loggedOut');
        expect(store.publicConfig.customLoginPath).toBe('login');
        expect(store.publicConfig.enablePublicPage).toBe(false);
    });

    it('does not let a failed public config request mask a successful authenticated session', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();

        const data = {
            config: { password: 'changed', isDefaultPassword: false },
            misubs: [],
            profiles: [],
            ruleTemplates: [],
        };

        apiMocks.fetchInitialData.mockResolvedValue({ success: true, data });
        apiMocks.fetchPublicConfig.mockResolvedValue({
            success: false,
            error: 'HTTP 500',
            errorType: 'server',
        });

        await store.checkSession();

        expect(store.sessionState).toBe('loggedIn');
        expect(store.initialData).toEqual(data);
        expect(store.publicConfig.customLoginPath).toBe('login');
    });

    it('preserves the last known public config after a later fetch failure', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();
        const data = { config: {}, misubs: [], profiles: [], ruleTemplates: [] };
        apiMocks.fetchInitialData.mockResolvedValue({ success: true, data });
        apiMocks.fetchPublicConfig.mockResolvedValueOnce({
            success: true,
            data: { customLoginPath: 'admin-login', enablePublicPage: true },
        });
        await store.checkSession();

        apiMocks.fetchPublicConfig.mockResolvedValueOnce({ success: false, error: 'network down' });
        await store.checkSession();

        expect(store.publicConfig.customLoginPath).toBe('admin-login');
        expect(store.publicConfig.enablePublicPage).toBe(true);
    });

    it('keeps a failed logout from claiming the session was cleared', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();
        store.sessionState = 'loggedIn';
        apiMocks.apiGet.mockRejectedValue(new Error('network down'));
        apiMocks.fetchInitialData.mockResolvedValue({
            success: true,
            data: { misubs: [], profiles: [], ruleTemplates: [], config: {} },
        });

        const errorSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(store.logout()).resolves.toBe(false);
            expect(store.sessionState).toBe('loggedIn');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('waits for session confirmation before redirecting after login', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();
        apiMocks.login.mockResolvedValue({ success: true, data: {} });
        apiMocks.fetchInitialData.mockResolvedValue({
            success: true,
            data: { misubs: [], profiles: [], ruleTemplates: [], config: {} },
        });
        apiMocks.fetchPublicConfig.mockResolvedValue({ success: true, data: {} });

        await store.login('password');

        expect(store.sessionState).toBe('loggedIn');
    });

    it('keeps default-password warning from login response for immediate frontend display', async () => {
        const { useSessionStore } = await import('../../src/stores/session.js');
        const store = useSessionStore();

        apiMocks.login.mockResolvedValue({
            success: true,
            data: {
                securityWarning: {
                    type: 'default_admin_password',
                    shouldChangePassword: true,
                    message: '当前正在使用默认管理员密码 admin，请登录后立即修改。',
                },
            },
        });
        apiMocks.fetchInitialData.mockResolvedValue({
            success: true,
            data: {
                config: { isDefaultPassword: true },
                misubs: [],
                profiles: [],
                ruleTemplates: [],
            },
        });
        apiMocks.fetchPublicConfig.mockResolvedValue({
            success: true,
            data: { customLoginPath: 'login' },
        });

        await store.login('admin');

        expect(store.securityWarning).toMatchObject({
            type: 'default_admin_password',
            shouldChangePassword: true,
        });
    });
});
