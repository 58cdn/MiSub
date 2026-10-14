import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite transactions implementing the D1 binding surface; no SQL parser mocks.
export function securityDatabase(enabled = true) {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(
        readFileSync(
            new URL('../../migrations/login-security/0001_login_security.sql', import.meta.url),
            'utf8'
        )
    );
    sqlite.prepare('UPDATE login_security_config SET enabled=?').run(+enabled);
    const prepare = (sql, values = []) => ({
        bind: (...params) => prepare(sql, params),
        first: async () => sqlite.prepare(sql).get(...values) || null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
        run: async () => ({ meta: sqlite.prepare(sql).run(...values) }),
        execute: () => ({ results: sqlite.prepare(sql).all(...values) }),
    });
    const binding = {
        prepare,
        async batch(statements) {
            sqlite.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map((statement) => statement.execute());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
    };
    return { sqlite, binding };
}
