// Candidate D1 persistence boundary. Schema installation is an explicit external operation.
// No request creates tables, initializes records, binds resources, or falls back to KV.
export class SessionStateUnavailable extends Error {
    constructor(code = 'session_store_unavailable') {
        super(code);
        this.status = 503;
        this.code = code;
    }
}

export const SESSION_STATE_SCHEMA = `
CREATE TABLE misub_session_authority (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    document TEXT NOT NULL CHECK (json_valid(document))
);
INSERT INTO misub_session_authority(id, revision, document)
VALUES(1, 0, '{"schema":1,"sessions":{},"tickets":{},"snapshots":{}}');
`;

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
        ['sessions', 'tickets', 'snapshots'].some(
            (key) => !state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])
        )
    )
        throw new SessionStateUnavailable('session_store_invalid');
    return state;
};

export class D1SessionState {
    constructor(binding, { maxAttempts = 8 } = {}) {
        if (!binding || typeof binding.prepare !== 'function') throw new SessionStateUnavailable();
        this.binding = binding;
        this.maxAttempts = maxAttempts;
    }
    primary() {
        // Each new read/attempt gets a new session whose FIRST query visits the primary.
        // Reusing one first-primary session for later authentication reads is unsafe.
        return typeof this.binding.withSession === 'function'
            ? this.binding.withSession('first-primary')
            : this.binding;
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
            if (revision >= Number.MAX_SAFE_INTEGER)
                throw new SessionStateUnavailable('session_revision_exhausted');
            // The action must have no external side effects. A CAS conflict repeats it on
            // authoritative state; immutable operation identifiers are supplied by the caller.
            const result = await action(state);
            const document = JSON.stringify(state);
            validate({ revision: revision + 1, document });
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
