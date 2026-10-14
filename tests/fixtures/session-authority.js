import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createSessionFixture({ initialize = true } = {}) {
    const sql = new DatabaseSync(':memory:');
    if (initialize)
        sql.exec(
            readFileSync(
                new URL('../../docs/schema/session-authority.sql', import.meta.url),
                'utf8'
            )
        );
    const calls = [];
    let unavailable = false,
        nextWrite,
        nextRead;
    const binding = {
        withSession(mode) {
            calls.push({ mode });
            let queries = 0;
            return {
                prepare(query) {
                    if (mode !== 'first-primary' || ++queries > 1)
                        throw new Error('Non-authoritative read');
                    return binding.prepare(query);
                },
            };
        },
        prepare(query) {
            if (unavailable) throw new Error('Synthetic D1 outage');
            calls.push({ query });
            return {
                async first() {
                    const row = sql.prepare(query).get();
                    const hook = nextRead;
                    nextRead = null;
                    if (hook) await hook(row);
                    return row;
                },
                bind(...args) {
                    return {
                        async run() {
                            const hook = nextWrite;
                            nextWrite = null;
                            if (hook) return hook(query, args);
                            return {
                                success: true,
                                meta: { changes: sql.prepare(query).run(...args).changes },
                            };
                        },
                    };
                },
            };
        },
    };
    return {
        sql,
        binding,
        calls,
        env: {
            SESSION_AUTH_MODE: 'd1-v1',
            MISUB_SESSION_DB: binding,
            ADMIN_PASSWORD: 'synthetic-password',
        },
        state: () =>
            JSON.parse(
                sql.prepare('SELECT document FROM misub_session_authority WHERE id=1').get()
                    .document
            ),
        setUnavailable: (value) => {
            unavailable = value;
        },
        writeHook: (fn) => {
            nextWrite = fn;
        },
        readHook: (fn) => {
            nextRead = fn;
        },
        close: () => sql.close(),
    };
}
