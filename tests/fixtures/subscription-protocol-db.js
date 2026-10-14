import { DatabaseSync } from 'node:sqlite';
import { planOfflineSubscriptionMigration } from '../../experiments/subscription-transactions/migration.js';
import { StorageFactory } from '../../functions/storage-adapter.js';

// Real SQLite SQL/batch adapter; failures rollback the database, not a JavaScript Map.
export async function createProtocolFixture({
    subscriptions = [],
    profiles = [],
    settings,
    ruleTemplates,
    now,
} = {}) {
    const sql = new DatabaseSync(':memory:');
    // Align SQLite's admission clock with controlled fixture clocks, including vi.setSystemTime.
    sql.function('julianday', (_value) => 2440587.5 + (now ? now() : Date.now()) / 86400000);
    sql.exec('PRAGMA foreign_keys=ON');
    for (const name of ['subscriptions', 'profiles'])
        sql.exec(
            `CREATE TABLE ${name}(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT,updated_at TEXT)`
        );
    sql.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
    const toRows = (items) => items.map((item) => ({ id: item.id, data: JSON.stringify(item) }));
    const migration = await planOfflineSubscriptionMigration({
        subscriptions: toRows(subscriptions),
        profiles: toRows(profiles),
        authority: 'fixture-authority',
        epoch: 'fixture-epoch',
    });
    const state = { failAt: -1, batches: 0, plans: [] };
    function prepare(text, args = []) {
        return {
            sql: text,
            args,
            bind(...values) {
                return prepare(text, values);
            },
            async first(column) {
                const row = sql.prepare(text).get(...args);
                return column ? (row?.[column] ?? null) : (row ?? null);
            },
            async all() {
                return { results: sql.prepare(text).all(...args) };
            },
            async run() {
                return sql.prepare(text).run(...args);
            },
        };
    }
    const db = {
        prepare,
        async batch(statements) {
            state.batches++;
            state.plans.push(statements.map(({ sql: text }) => text));
            sql.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map((statement, index) => {
                    if (index === state.failAt) sql.prepare("SELECT json('invalid-fixture')").get();
                    const compiled = sql.prepare(statement.sql);
                    return compiled.columns().length
                        ? { results: compiled.all(...statement.args) }
                        : { results: [], meta: compiled.run(...statement.args) };
                });
                sql.exec('COMMIT');
                return results;
            } catch (error) {
                sql.exec('ROLLBACK');
                throw error;
            }
        },
    };
    const legacy = StorageFactory.createAdapter({ MISUB_DB: db }, 'd1');
    if (settings !== undefined) await legacy.put('worker_settings_v1', settings);
    if (ruleTemplates !== undefined) await legacy.put('misub_rule_templates_v1', ruleTemplates);
    await db.batch(migration.statements.map(({ sql: text, args }) => prepare(text, args)));
    state.batches = 0;
    state.plans = [];
    return {
        sql,
        db,
        state,
        now,
        env: {
            MISUB_DB: db,
            MISUB_SUBSCRIPTION_PROTOCOL: 'd1-v1',
            MISUB_SUBSCRIPTION_AUTHORITY: 'fixture-authority',
        },
        close: () => sql.close(),
    };
}
