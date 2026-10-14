import { DatabaseSync } from 'node:sqlite';
// Real SQLite statements; D1's prepare/bind/first/all/run/batch surface, not a mocked SQL parser.
export function database() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    const prepare = (sql, params = []) => ({
        bind: (...values) => prepare(sql, values),
        first: async () => db.prepare(sql).get(...params) || null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => ({ meta: db.prepare(sql).run(...params) }),
        runSync: () => {
            const results = db.prepare(sql).all(...params);
            const meta = db
                .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
                .get();
            return { results, meta };
        },
    });
    return {
        prepare,
        async batch(statements) {
            db.exec('BEGIN');
            try {
                const out = [];
                for (const s of statements) out.push(s.runSync());
                db.exec('COMMIT');
                return out;
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        },
    };
}
