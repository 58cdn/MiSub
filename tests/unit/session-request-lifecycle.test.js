import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '../../src/stores/session.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { api, configureUnauthorizedHandler } from '../../src/lib/http.js';
import router from '../../src/router';

vi.mock('../../src/router', () => ({ default: { push: vi.fn() } }));
vi.mock('../../src/stores/toast', () => ({ useToastStore: () => ({ showToast: vi.fn() }) }));
vi.mock('../../src/utils/errorHandler.js', () => ({ handleError: vi.fn() }));

const snapshot = (name) => ({
    misubs: [{ id: 'a', name, url: 'https://example.invalid/a' }],
    profiles: [],
    ruleTemplates: [],
    config: { siteName: name },
});
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { resolve, promise };
};
let queues;
function enqueue(url, result) {
    const queue = queues.get(url) || [];
    queue.push(result);
    queues.set(url, queue);
}
function checked(name) {
    enqueue('/api/data', response(snapshot(name)));
    enqueue('/api/public_config', response({ enablePublicPage: false }));
}
async function loggedIn() {
    checked('original');
    const session = useSessionStore();
    await session.checkSession();
    return session;
}
beforeEach(() => {
    setActivePinia(createPinia());
    sessionStorage.clear();
    queues = new Map();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
        'fetch',
        vi.fn((url) => {
            if (url === '/api/session/protocol')
                return Promise.resolve(response({ protocol: 'legacy' }));
            const queue = queues.get(url);
            if (!queue?.length) throw new Error(`Unexpected offline request: ${url}`);
            return Promise.resolve(queue.shift());
        })
    );
    configureUnauthorizedHandler(() => void useSessionStore().handleUnauthorized());
});
afterEach(() => {
    configureUnauthorizedHandler(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('session request lifecycle through real HTTP', () => {
    it.each(['/api/data', '/api/public_config'])(
        'ignores an old check 401 from %s after a newer check succeeds',
        async (url) => {
            const session = await loggedIn(),
                old = deferred();
            enqueue('/api/data', url === '/api/data' ? old.promise : response(snapshot('old')));
            enqueue(
                '/api/public_config',
                url === '/api/public_config' ? old.promise : response({})
            );
            const checking = session.checkSession();
            checked('new');
            await session.checkSession();
            old.resolve(response({ error: 'Unauthorized' }, 401));
            await checking;
            expect(session.sessionState).toBe('loggedIn');
            expect(session.initialData.config.siteName).toBe('new');
        }
    );
    it('reports the current wrong-password response while already logged in', async () => {
        const session = await loggedIn();
        enqueue('/api/login', response({ error: 'synthetic incorrect password' }, 401));
        await expect(session.login('wrong')).rejects.toThrow('synthetic incorrect password');
        expect(session.sessionState).toBe('loggedIn');
    });
    it('does not restore a session from a check completed after logout', async () => {
        const session = await loggedIn(),
            old = deferred();
        enqueue('/api/data', old.promise);
        enqueue('/api/public_config', response({}));
        const checking = session.checkSession();
        enqueue('/api/logout', response({ success: true }));
        await session.logout();
        old.resolve(response(snapshot('old')));
        await checking;
        expect(session.sessionState).toBe('loggedOut');
        expect(session.initialData).toBeNull();
        expect(session.subscriptionConfig).toEqual({});
    });
    it('uses the latest check when successful reads complete out of order', async () => {
        const session = await loggedIn(),
            old = deferred();
        enqueue('/api/data', old.promise);
        enqueue('/api/public_config', response({}));
        const checking = session.checkSession();
        checked('new');
        await session.checkSession();
        old.resolve(response(snapshot('old')));
        await checking;
        expect(useDataStore().subscriptions[0].name).toBe('new');
        expect(session.initialData.config.siteName).toBe('new');
    });
    it('does not let a prior-session notification 401 log out a new session', async () => {
        const session = await loggedIn(),
            old = deferred();
        enqueue('/api/admin/notifications', old.promise);
        const notification = api.get('/api/admin/notifications').catch((error) => error);
        enqueue('/api/logout', response({ success: true }));
        await session.logout();
        enqueue('/api/login', response({ success: true }));
        checked('new');
        await session.login('fixture');
        old.resolve(response({ error: 'Unauthorized' }, 401));
        expect((await notification).status).toBe(401);
        expect(session.sessionState).toBe('loggedIn');
        expect(session.initialData.config.siteName).toBe('new');
    });
    it('still clears a current session on a current notification 401', async () => {
        const session = await loggedIn();
        enqueue('/api/admin/notifications', response({ error: 'Unauthorized' }, 401));
        await expect(api.get('/api/admin/notifications')).rejects.toMatchObject({ status: 401 });
        expect(session.sessionState).toBe('loggedOut');
        expect(session.subscriptionConfig).toEqual({});
    });
    it('requires successful hydration before publishing loggedIn', async () => {
        vi.spyOn(useDataStore(), 'hydrateFromData').mockReturnValue(false);
        checked('invalid');
        const session = useSessionStore();
        expect(await session.checkSession()).toBe(false);
        expect(session.sessionState).toBe('loggedOut');
        expect(session.initialData).toBeNull();
    });
    it('ignores a login response that completes after an explicit logout', async () => {
        const session = useSessionStore(),
            old = deferred();
        enqueue('/api/login', old.promise);
        const login = session.login('fixture');
        enqueue('/api/logout', response({ success: true }));
        await session.logout();
        old.resolve(response({ success: true, loginSecurity: { enabled: true } }));
        expect(await login).toBe(false);
        expect(session.sessionState).toBe('loggedOut');
        expect(session.loginSecurity).toBeNull();
        expect(router.push).not.toHaveBeenCalledWith({ path: '/dashboard' });
    });
    it('does not apply an old logout fallback after a newer login', async () => {
        const session = await loggedIn(),
            old = deferred();
        enqueue('/api/logout', response({ error: 'offline' }, 500));
        enqueue('/api/data', old.promise);
        const logout = session.logout();
        await vi.waitFor(() =>
            expect(fetch.mock.calls.filter(([url]) => url === '/api/data')).toHaveLength(2)
        );
        enqueue('/api/login', response({ success: true }));
        checked('new');
        await session.login('fixture');
        old.resolve(response({ authenticated: false }));
        expect(await logout).toBe(false);
        expect(session.sessionState).toBe('loggedIn');
        expect(session.initialData.config.siteName).toBe('new');
    });
});
