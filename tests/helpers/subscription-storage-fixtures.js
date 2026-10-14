import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';

export const COLLECTIONS = [
    ['subscriptions', 'misub_subscriptions_v1', 'getAllSubscriptions'],
    ['profiles', 'misub_profiles_v1', 'getAllProfiles'],
];

export function makeKV(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        get: vi.fn(async (key) => store.get(key) ?? null),
        put: vi.fn(async (key, value) => store.set(key, value)),
        delete: vi.fn(async (key) => store.delete(key)),
        list: vi.fn(async () => ({ keys: [] })),
    };
}

// Local SQLite only; faults intercept reads, and every adapter write is recorded.
export function makeD1() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
        CREATE TABLE subscriptions (id TEXT PRIMARY KEY, data TEXT, updated_at TEXT);
        CREATE TABLE profiles (id TEXT PRIMARY KEY, data TEXT, updated_at TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
        INSERT INTO settings VALUES ('main', '{"storageType":"d1"}', NULL);
    `);
    const faults = new Map();
    const writes = [];
    const reads = [];
    const database = {
        prepare(sql) {
            const statement = (args = []) => ({
                bind: (...values) => statement(values),
                async all() {
                    reads.push(sql);
                    const table = /FROM (subscriptions|profiles)/.exec(sql)?.[1];
                    if (faults.has(table)) return faults.get(table)();
                    return { success: true, results: sqlite.prepare(sql).all(...args) };
                },
                async first() {
                    reads.push(sql);
                    return sqlite.prepare(sql).get(...args) ?? null;
                },
                async run() {
                    writes.push({ sql, args });
                    sqlite.prepare(sql).run(...args);
                    return { success: true };
                },
            });
            return statement();
        },
    };
    return { database, sqlite, faults, writes, reads };
}

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
