// Browser-only experiment. Stores cancellation capabilities and public SID metadata,
// never passwords or session bearer credentials. Missing storage must fail closed.
export function createPendingLoginRegistry(indexedDB, name = 'misub-session-protocol-fixture') {
    const opened = new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('coordination');
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Registry upgrade blocked'));
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
                        next: 0,
                        intents: {},
                        known: [],
                        knownTickets: {},
                        logouts: {},
                    };
                    state.recoveries ||= {};
                    result = action(state);
                    store.put(state, 'state');
                } catch (error) {
                    reject(error);
                    tx.abort();
                }
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('Registry unavailable'));
        });
    }
    return {
        // Register before the ticket HTTP request; a delayed ticket cannot create a new intent.
        begin: () =>
            transact((state) => {
                if (Object.keys(state.recoveries).length) throw new Error('recovery_in_progress');
                if (Object.keys(state.intents).length >= 16) throw new Error('pending_login_limit');
                for (const item of Object.values(state.intents))
                    if (!item.ticket) item.cancelled = true;
                const intent = {
                    id: `intent-${crypto.randomUUID()}`,
                    cancelled: false,
                    priorIds: [...state.known],
                    priorTickets: Object.values(state.intents).flatMap((item) =>
                        item.ticket ? [item.ticket] : []
                    ),
                };
                state.intents[intent.id] = intent;
                return structuredClone(intent);
            }),
        bind: (id, ticket) =>
            transact((state) => {
                const item = state.intents[id];
                if (!item || item.cancelled) return false;
                if (item.ticket)
                    return (
                        item.ticket.id === ticket.id &&
                        item.ticket.cancelToken === ticket.cancelToken &&
                        item.ticket.deadline === ticket.deadline
                    );
                item.ticket = ticket;
                return true;
            }),
        snapshotLogout: () =>
            transact((state) => {
                const intentIds = Object.keys(state.intents);
                const target = {
                    id: `logout-${crypto.randomUUID()}`,
                    ids: [...state.known],
                    tickets: Object.values(state.intents).flatMap((item) =>
                        item.ticket ? [item.ticket] : []
                    ),
                    intentIds,
                };
                for (const item of Object.values(state.intents)) item.cancelled = true;
                state.logouts[target.id] = target;
                return structuredClone(target);
            }),
        retryLogout: (id) => transact((state) => structuredClone(state.logouts[id])),
        canConfirm: (id) =>
            transact(
                (state) =>
                    !Object.keys(state.recoveries).length &&
                    !!state.intents[id]?.ticket &&
                    !state.intents[id].cancelled
            ),
        beginRecovery: () =>
            transact((state) => {
                const existing = Object.values(state.recoveries)[0];
                if (existing) return structuredClone(existing);
                const recovery = {
                    id: `recovery-${crypto.randomUUID()}`,
                    intentIds: Object.keys(state.intents),
                    knownIds: [...state.known],
                    tickets: Object.values(state.intents).flatMap((item) =>
                        item.ticket ? [item.ticket] : []
                    ),
                };
                for (const item of Object.values(state.intents)) item.cancelled = true;
                state.recoveries[recovery.id] = recovery;
                return structuredClone(recovery);
            }),
        bindRecovery: (id, snapshot) =>
            transact((state) => {
                const recovery = state.recoveries[id];
                if (!recovery) return false;
                if (recovery.snapshot)
                    return (
                        recovery.snapshot.id === snapshot.id &&
                        recovery.snapshot.proof === snapshot.proof
                    );
                recovery.snapshot = structuredClone(snapshot);
                return true;
            }),
        retryRecovery: (id) => transact((state) => structuredClone(state.recoveries[id])),
        completeRecovery: (id) =>
            transact((state) => {
                const recovery = state.recoveries[id];
                if (!recovery?.snapshot) throw new Error('recovery_unconfirmed');
                for (const intentId of recovery.intentIds) delete state.intents[intentId];
                const captured = new Set([...recovery.knownIds, ...recovery.snapshot.ids]);
                state.known = state.known.filter((sid) => !captured.has(sid));
                for (const sid of captured) delete state.knownTickets[sid];
                delete state.recoveries[id];
            }),
        completeLogout: (id) =>
            transact((state) => {
                const target = state.logouts[id];
                if (!target) return;
                for (const intentId of target.intentIds) delete state.intents[intentId];
                state.known = state.known.filter((sid) => !target.ids.includes(sid));
                for (const sid of target.ids) delete state.knownTickets[sid];
                delete state.logouts[id];
            }),
        acknowledge: (id, sid, cookieConfirmed) =>
            transact((state) => {
                const item = state.intents[id];
                if (!cookieConfirmed || !item?.ticket || item.cancelled) return false;
                const replaced = new Set(item.priorTickets.map((ticket) => ticket.id));
                state.known = [
                    ...new Set([
                        ...state.known.filter(
                            (value) =>
                                !item.priorIds.includes(value) &&
                                !replaced.has(state.knownTickets[value])
                        ),
                        sid,
                    ]),
                ];
                state.knownTickets[sid] = item.ticket.id;
                for (const key of Object.keys(state.knownTickets))
                    if (!state.known.includes(key)) delete state.knownTickets[key];
                for (const [key, value] of Object.entries(state.intents))
                    if (key === id || replaced.has(value.ticket?.id)) delete state.intents[key];
                return true;
            }),
        close: async () => (await opened).close(),
    };
}
