const random = (size) =>
    Array.from(crypto.getRandomValues(new Uint8Array(size)), (b) =>
        b.toString(16).padStart(2, '0')
    ).join('');

// Shared across tabs. Only cancellation capabilities and public identifiers are persisted.
export function createSessionRegistry(indexedDB, name = 'misub-session-coordination-v1') {
    const opened = new Promise((resolve, reject) => {
        if (!indexedDB) return reject(new Error('session_storage_unavailable'));
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('coordination');
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(new Error('session_storage_unavailable'));
        request.onblocked = () => reject(new Error('session_storage_blocked'));
    });
    async function transact(action) {
        const db = await opened;
        return new Promise((resolve, reject) => {
            const tx = db.transaction('coordination', 'readwrite');
            const store = tx.objectStore('coordination');
            let result;
            const read = store.get('state');
            read.onsuccess = () => {
                try {
                    const state = read.result || {
                        version: 1,
                        intents: {},
                        known: {},
                        recovery: null,
                    };
                    if (state.version !== 1 || !state.intents || !state.known)
                        throw new Error('session_storage_invalid');
                    result = structuredClone(action(state));
                    store.put(state, 'state');
                } catch (error) {
                    reject(error);
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(new Error('session_storage_unavailable'));
        });
    }
    const tickets = (state) => [
        ...new Map(
            [
                ...Object.values(state.known),
                ...Object.values(state.intents).flatMap((i) => (i.ticket ? [i.ticket] : [])),
            ].map((t) => [t.id, t])
        ).values(),
    ];
    return {
        begin: () =>
            transact((state) => {
                if (state.recovery) throw new Error('session_recovery_pending');
                for (const [id, item] of Object.entries(state.intents)) {
                    item.cancelled = true;
                    if (!item.ticket) delete state.intents[id];
                }
                if (tickets(state).length >= 32) throw new Error('session_recovery_required');
                const intent = {
                    id: random(16),
                    priorIds: Object.keys(state.known),
                    priorTickets: tickets(state),
                    cancelled: false,
                    ticket: null,
                };
                state.intents[intent.id] = intent;
                return intent;
            }),
        abandonUnbound: (id) =>
            transact((state) => {
                if (!state.intents[id]?.ticket) delete state.intents[id];
            }),
        bind: (id, ticket) =>
            transact((state) => {
                const item = state.intents[id];
                if (!item || item.cancelled || state.recovery) return false;
                if (item.ticket)
                    return (
                        item.ticket.id === ticket.id &&
                        item.ticket.cancelToken === ticket.cancelToken
                    );
                item.ticket = ticket;
                return true;
            }),
        canConfirm: (id) =>
            transact(
                (state) =>
                    !!state.intents[id]?.ticket && !state.intents[id].cancelled && !state.recovery
            ),
        canStart: (id) =>
            transact(
                (state) => !!state.intents[id] && !state.intents[id].cancelled && !state.recovery
            ),
        acknowledge: (id, sid) =>
            transact((state) => {
                const item = state.intents[id];
                if (!item?.ticket || item.cancelled || state.recovery) return false;
                const replaced = new Set(item.priorTickets.map((t) => t.id));
                for (const [key, ticket] of Object.entries(state.known))
                    if (item.priorIds.includes(key) || replaced.has(ticket.id))
                        delete state.known[key];
                state.known[sid] = item.ticket;
                for (const [key, other] of Object.entries(state.intents))
                    if (key === id || replaced.has(other.ticket?.id)) delete state.intents[key];
                return true;
            }),
        pending: () => transact((state) => state.recovery),
        beginRecovery: (serverNow) =>
            transact((state) => {
                if (state.recovery) return state.recovery;
                state.recovery = {
                    id: random(16),
                    proof: random(32),
                    createdAt: serverNow,
                    intentIds: Object.keys(state.intents),
                    ids: Object.keys(state.known),
                    tickets: tickets(state),
                    snapshot: null,
                };
                for (const item of Object.values(state.intents)) item.cancelled = true;
                return state.recovery;
            }),
        bindRecovery: (id, snapshot) =>
            transact((state) => {
                if (state.recovery?.id !== id) return false;
                if (state.recovery.snapshot) return state.recovery.snapshot.id === snapshot.id;
                state.recovery.snapshot = snapshot;
                return true;
            }),
        refreshRecovery: (id, serverNow) =>
            transact((state) => {
                if (state.recovery?.id !== id || state.recovery.snapshot)
                    throw new Error('session_recovery_pending');
                state.recovery = {
                    ...state.recovery,
                    id: random(16),
                    proof: random(32),
                    createdAt: serverNow,
                };
                return state.recovery;
            }),
        completeRecovery: (id) =>
            transact((state) => {
                const recovery = state.recovery;
                if (!recovery || recovery.id !== id) return;
                if (!recovery.snapshot) throw new Error('session_recovery_unconfirmed');
                for (const intentId of recovery.intentIds) delete state.intents[intentId];
                for (const sid of [...recovery.ids, ...recovery.snapshot.ids])
                    delete state.known[sid];
                state.recovery = null;
            }),
        resumeFreshLogin: (id, settled) =>
            transact((state) => {
                const recovery = state.recovery;
                if (
                    !recovery ||
                    recovery.id !== id ||
                    recovery.snapshot ||
                    !settled ||
                    recovery.ids.some((sid) => !settled.ids?.includes(sid)) ||
                    recovery.tickets.some((t) => !settled.tickets?.includes(t.id))
                )
                    throw new Error('session_recovery_pending');
                for (const intentId of recovery.intentIds) delete state.intents[intentId];
                for (const sid of recovery.ids) delete state.known[sid];
                state.recovery = null;
                return { logoutConfirmed: false };
            }),
        close: async () => (await opened).close(),
    };
}
