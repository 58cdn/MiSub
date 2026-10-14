// Session authority uses one bounded document and a revision CAS for atomic revocation.
// Schema installation is a separate administrator operation.
export class SessionStateUnavailable extends Error {
    constructor(code = 'session_store_unavailable') {
        super(code);
        this.status = 503;
        this.code = code;
    }
}

const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const ids = (value, max) =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((id) => typeof id === 'string' && ID.test(id)) &&
    new Set(value).size === value.length;

const validate = (row) => {
    if (
        !row ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        typeof row.document !== 'string' ||
        new TextEncoder().encode(row.document).length > 262144
    )
        throw new SessionStateUnavailable('session_store_invalid');
    let state;
    try {
        state = JSON.parse(row.document);
    } catch {
        throw new SessionStateUnavailable('session_store_invalid');
    }
    if (
        state?.schema !== 1 ||
        typeof state.receiptKey !== 'string' ||
        !HASH.test(state.receiptKey) ||
        ['sessions', 'tickets', 'snapshots'].some(
            (key) =>
                !record(state[key]) ||
                Object.keys(state[key]).length > 256 ||
                Object.keys(state[key]).some((id) => !ID.test(id))
        )
    )
        throw new SessionStateUnavailable('session_store_invalid');
    if (
        Object.values(state.sessions).some(
            (s) =>
                !record(s) ||
                !HASH.test(s.secretHash) ||
                !timestamp(s.expires) ||
                !timestamp(s.absoluteExpires) ||
                s.expires > s.absoluteExpires ||
                typeof s.active !== 'boolean' ||
                typeof s.revoked !== 'boolean' ||
                (s.replaceIds !== undefined && !ids(s.replaceIds, 32)) ||
                (s.replaceTickets !== undefined && !ids(s.replaceTickets, 64))
        ) ||
        Object.values(state.tickets).some(
            (t) =>
                !record(t) ||
                !HASH.test(t.cancelHash) ||
                !timestamp(t.deadline) ||
                (t.sid !== null && !ID.test(t.sid)) ||
                typeof t.cancelled !== 'boolean'
        ) ||
        Object.values(state.snapshots).some(
            (s) =>
                !record(s) ||
                !HASH.test(s.proofHash) ||
                !timestamp(s.expires) ||
                !timestamp(s.receiptExpires) ||
                !timestamp(s.createdAt) ||
                !ids(s.ids, 32) ||
                !ids(s.tickets, 64) ||
                typeof s.completed !== 'boolean'
        )
    )
        throw new SessionStateUnavailable('session_store_invalid');
    return state;
};

export class D1SessionState {
    constructor(binding, { maxAttempts = 8 } = {}) {
        if (
            !binding ||
            typeof binding.prepare !== 'function' ||
            typeof binding.withSession !== 'function'
        )
            throw new SessionStateUnavailable();
        this.binding = binding;
        this.maxAttempts = maxAttempts;
    }
    primary() {
        // Each new read/attempt gets a new session whose FIRST query visits the primary.
        // Reusing one first-primary session for later authentication reads is unsafe.
        return this.binding.withSession('first-primary');
    }
    async read() {
        try {
            const row = await this.primary()
                .prepare('SELECT revision, document FROM misub_session_authority WHERE id=1')
                .first();
            return { revision: row?.revision, state: validate(row) };
        } catch (error) {
            if (error instanceof SessionStateUnavailable) throw error;
            throw new SessionStateUnavailable();
        }
    }
    async mutate(action) {
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            const { revision, state } = await this.read();
            const original = JSON.stringify(state);
            if (revision >= Number.MAX_SAFE_INTEGER)
                throw new SessionStateUnavailable('session_revision_exhausted');
            // The action must have no external side effects. A CAS conflict repeats it on
            // authoritative state; immutable operation identifiers are supplied by the caller.
            const result = await action(state);
            const document = JSON.stringify(state);
            validate({ revision: revision + 1, document });
            if (document === original) return result;
            let written;
            try {
                written = await this.binding
                    .prepare(
                        'UPDATE misub_session_authority SET document=?, revision=revision+1 WHERE id=1 AND revision=?'
                    )
                    .bind(document, revision)
                    .run();
            } catch {
                // Commit may have succeeded before transport failure. No blind retry here:
                // the caller must reuse the operation receipt, never reissue credentials.
                throw new SessionStateUnavailable('session_commit_unconfirmed');
            }
            if (written?.success === false) throw new SessionStateUnavailable();
            if (written?.meta?.changes === 1) return result;
            if (written?.meta?.changes !== 0)
                throw new SessionStateUnavailable('session_commit_unconfirmed');
        }
        throw new SessionStateUnavailable('session_store_busy');
    }
}
