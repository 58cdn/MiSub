import { createSessionRegistry } from './session-registry.js';
import { api } from './http.js';

const changed = () => Object.assign(new Error('会话已变化，请重试。'), { code: 'session_changed' });
const options = { shouldHandleUnauthorized: () => false };
export function createSessionClient({
    transport = api,
    indexedDB = globalThis.indexedDB,
    storage = globalThis.localStorage,
    notify = () => {},
} = {}) {
    let registry;
    let serverOffset = 0;
    const local = () => (registry ||= createSessionRegistry(indexedDB));
    const fenceKey = 'misub-session-logout-generation';
    const attempt = (promise) =>
        promise.then(
            (value) => ({ value }),
            (error) => ({ error })
        );
    function readFence() {
        try {
            return { value: storage.getItem(fenceKey) };
        } catch {
            return { error: new Error('session_storage_unavailable') };
        }
    }
    function assertFence(fence) {
        if (fence.error) throw fence.error;
        if (storage.getItem(fenceKey) !== fence.value) throw changed();
    }
    async function protocol() {
        const result = await transport.get('/api/session/protocol', options);
        if (!['legacy', 'd1-v1'].includes(result?.protocol))
            throw new Error('session_protocol_unavailable');
        if (result.protocol === 'd1-v1') {
            if (!Number.isSafeInteger(result.serverNow))
                throw new Error('session_protocol_unavailable');
            serverOffset = result.serverNow - Date.now();
        }
        return result.protocol;
    }
    async function recover({ allowFreshLogin = false, refreshed = false, operation = null } = {}) {
        let recovery = operation || (await local().beginRecovery(Date.now() + serverOffset));
        notify('logout-pending');
        if (!recovery.snapshot) {
            let snapshot;
            try {
                snapshot = await transport.post(
                    '/api/session/capture',
                    {
                        recovery: {
                            id: recovery.id,
                            proof: recovery.proof,
                            createdAt: recovery.createdAt,
                        },
                        ids: recovery.ids,
                        tickets: recovery.tickets,
                    },
                    options
                );
            } catch (error) {
                if (
                    !refreshed &&
                    error.data?.code === 'recovery_capture_expired' &&
                    Number.isSafeInteger(error.data.serverNow)
                ) {
                    await local().refreshRecovery(recovery.id, error.data.serverNow);
                    return recover({ allowFreshLogin, refreshed: true });
                }
                if (allowFreshLogin && error.data?.code === 'logout_recovery_unconfirmed') {
                    await local().resumeFreshLogin(recovery.id, error.data.settled);
                    return { success: false, logoutConfirmed: false };
                }
                throw error;
            }
            if (!(await local().bindRecovery(recovery.id, snapshot))) throw changed();
            recovery = { ...recovery, snapshot };
        }
        const result = await transport.post(
            '/api/logout',
            {
                recovery: { id: recovery.id, proof: recovery.proof },
                receipt: recovery.snapshot.receipt,
            },
            options
        );
        if (!result?.success) throw new Error('session_recovery_unconfirmed');
        await local().completeRecovery(recovery.id);
        notify('logout-complete');
        // Expired names are immutable; a delayed cleanup cannot delete a newer SID.
        await transport.post('/api/session/cleanup', {}, options).catch(() => {});
        return { success: true, logoutConfirmed: true };
    }
    return {
        protocol,
        async login(password) {
            // Register before the first HTTP request. The synchronous cross-tab fence
            // also covers IndexedDB opening and protocol-discovery response delays.
            const fence = readFence();
            const registration = attempt(local().begin());
            if ((await protocol()) === 'legacy') {
                registration
                    .then(({ value }) => value && local().abandonUnbound(value.id))
                    .catch(() => {});
                return transport.post('/api/login', { password }, options);
            }
            assertFence(fence);
            let registered = await registration;
            if (await local().pending()) {
                await recover({ allowFreshLogin: true });
                assertFence(fence);
                registered = { value: await local().begin() };
            }
            if (registered.error) throw registered.error;
            const intent = registered.value;
            await transport.post('/api/session/cleanup', {}, options);
            assertFence(fence);
            if (!(await local().canStart(intent.id))) throw changed();
            let prepared;
            try {
                prepared = await transport.post('/api/session/prepare', { password }, options);
            } catch (error) {
                await local().abandonUnbound(intent.id);
                throw error;
            }
            assertFence(fence);
            if (!(await local().bind(intent.id, prepared.ticket))) throw changed();
            const result = await transport.post(
                '/api/login',
                {
                    password,
                    ticket: prepared.ticket,
                    priorIds: intent.priorIds,
                    priorTickets: intent.priorTickets,
                },
                options
            );
            assertFence(fence);
            if (!(await local().canConfirm(intent.id))) throw changed();
            const confirmed = await transport.post(
                '/api/session/confirm',
                { ticket: prepared.ticket },
                options
            );
            assertFence(fence);
            if (!confirmed.success || !(await local().acknowledge(intent.id, confirmed.id)))
                throw changed();
            notify('login-complete');
            return result;
        },
        async logout() {
            let fenceError;
            try {
                storage.setItem(fenceKey, crypto.randomUUID());
            } catch {
                fenceError = new Error('session_storage_unavailable');
            }
            const captured = attempt(local().beginRecovery(Date.now() + serverOffset));
            if ((await protocol()) === 'legacy') return { protocol: 'legacy' };
            if (fenceError) throw fenceError;
            const operation = await captured;
            if (operation.error) throw operation.error;
            return { protocol: 'd1-v1', ...(await recover({ operation: operation.value })) };
        },
        async recoveryPending() {
            if ((await protocol()) === 'legacy') return false;
            return !!(await local().pending());
        },
        close: async () => registry?.close(),
    };
}

let shared;
let channel;
const listeners = new Set();
export function onSessionChange(listener) {
    listeners.add(listener);
    if (!channel && typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('misub-session-events-v1');
        channel.onmessage = (event) => {
            for (const callback of listeners) callback(event.data);
        };
    }
    return () => listeners.delete(listener);
}
export function sessionClient() {
    return (shared ||= createSessionClient({ notify: (type) => channel?.postMessage(type) }));
}
