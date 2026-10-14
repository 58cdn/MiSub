// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { COLLECTIONS, makeKV, makeD1 } from '../helpers/subscription-storage-fixtures.js';

const READ_ERROR = { code: 'STORAGE_COLLECTION_READ_FAILED' };
const databases = [];
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('network forbidden');
        })
    );
});
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
function fixtureD1() {
    const fixture = makeD1();
    databases.push(fixture.sqlite);
    return {
        ...fixture,
        adapter: StorageFactory.createAdapter({ MISUB_DB: fixture.database }, 'd1'),
    };
}

describe.each(COLLECTIONS)('%s authoritative reads', (table, key, method) => {
    it.each(['throw', 'invalid-json', 'object', 'null', 'bad-item', 'missing-id'])(
        'KV rejects %s instead of empty data',
        async (fault) => {
            const values = {
                'invalid-json': '{fixture',
                object: '{}',
                null: 'null',
                'bad-item': '[null]',
                'missing-id': '[{}]',
            };
            const kv = makeKV({ [key]: values[fault] });
            if (fault === 'throw') kv.get.mockRejectedValue(new Error('sensitive-storage-detail'));
            const adapter = StorageFactory.createAdapter({ MISUB_KV: kv }, 'kv');
            await expect(adapter[method]()).rejects.toMatchObject(READ_ERROR);
            await expect(adapter.get(key)).rejects.toMatchObject(READ_ERROR);
            expect(kv.put).not.toHaveBeenCalled();
            expect(JSON.stringify(console.error.mock.calls)).not.toContain(
                'sensitive-storage-detail'
            );
        }
    );

    it.each([null, '[]', '[{"id":"fixture"}]'])(
        'KV accepts missing/empty/valid: %s',
        async (raw) => {
            const kv = makeKV({ [key]: raw });
            const adapter = StorageFactory.createAdapter({ MISUB_KV: kv }, 'kv');
            expect(await adapter[method]()).toEqual(raw ? JSON.parse(raw) : []);
            expect(kv.put).not.toHaveBeenCalled();
        }
    );

    it.each([
        'query',
        'missing-table',
        'invalid-result',
        'failed-result',
        'invalid-json',
        'scalar',
        'null',
        'bad-legacy-item',
        'missing-id',
    ])('D1 rejects %s and performs no schema/write operation', async (fault) => {
        const { adapter, sqlite, faults, writes } = fixtureD1();
        if (fault === 'query')
            faults.set(table, () => {
                throw new Error('sensitive-storage-detail');
            });
        else if (fault === 'missing-table') sqlite.exec(`DROP TABLE ${table}`);
        else if (fault === 'invalid-result') faults.set(table, () => ({ success: true }));
        else if (fault === 'failed-result')
            faults.set(table, () => ({ success: false, results: [] }));
        else {
            const values = {
                'invalid-json': '{fixture',
                scalar: '42',
                null: 'null',
                'bad-legacy-item': '[null]',
                'missing-id': '{}',
            };
            sqlite
                .prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
                .run('main', values[fault]);
        }
        await expect(adapter[method]({ authoritative: true })).rejects.toMatchObject(READ_ERROR);
        expect(writes).toEqual([]);
        expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-storage-detail');
    });

    it('D1 accepts empty tables, legacy main arrays and row records without migrating', async () => {
        const { adapter, sqlite, writes } = fixtureD1();
        expect(await adapter[method]({ authoritative: true })).toEqual([]);
        sqlite
            .prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
            .run('main', JSON.stringify([{ id: 'old', sortIndex: 1 }]));
        sqlite
            .prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
            .run('new', JSON.stringify({ id: 'new', sortIndex: 0 }));
        expect(await adapter[method]({ authoritative: true })).toEqual([
            { id: 'new', sortIndex: 0 },
            { id: 'old', sortIndex: 1 },
        ]);
        expect(writes).toEqual([]);
    });

    it('authoritative D1 read bypasses a warm cache and observes query failures', async () => {
        const { adapter, sqlite, faults } = fixtureD1();
        expect(await adapter[method]()).toEqual([]);
        sqlite.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`).run('new', '{"id":"new"}');
        expect(await adapter[method]({ authoritative: true })).toEqual([{ id: 'new' }]);
        faults.set(table, () => {
            throw new Error('sensitive-storage-detail');
        });
        await expect(adapter[method]({ authoritative: true })).rejects.toMatchObject(READ_ERROR);
    });

    it('D1 read failure never becomes a cached empty success and can be retried', async () => {
        const { adapter, sqlite, faults } = fixtureD1();
        faults.set(table, () => {
            throw new Error('unavailable');
        });
        await expect(adapter[method]()).rejects.toMatchObject(READ_ERROR);
        faults.delete(table);
        sqlite
            .prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
            .run('recovered', '{"id":"recovered"}');
        expect(await adapter[method]()).toEqual([{ id: 'recovered' }]);
    });
});

describe('KV read-modify-write protection', () => {
    it.each([
        ['putSubscription', 'misub_subscriptions_v1', [{ id: 'new' }]],
        ['deleteSubscriptionById', 'misub_subscriptions_v1', ['old']],
        [
            'updateSubscriptionById',
            'misub_subscriptions_v1',
            ['old', (item) => ({ ...item, nodeCount: 2 })],
        ],
        ['putProfile', 'misub_profiles_v1', [{ id: 'new' }]],
        ['deleteProfileById', 'misub_profiles_v1', ['old']],
    ])('%s cannot turn a failed read into a replacement collection', async (method, key, args) => {
        const kv = makeKV();
        kv.get.mockRejectedValue(new Error('read failed'));
        const adapter = StorageFactory.createAdapter({ MISUB_KV: kv }, 'kv');
        await expect(adapter[method](...args)).rejects.toMatchObject(READ_ERROR);
        expect(kv.get).toHaveBeenCalledWith(key);
        expect(kv.put).not.toHaveBeenCalled();
        expect(kv.delete).not.toHaveBeenCalled();
    });
    it('non-collection settings reads retain their fallback', async () => {
        const kv = makeKV();
        kv.get.mockRejectedValue(new Error('settings unavailable'));
        const adapter = StorageFactory.createAdapter({ MISUB_KV: kv }, 'kv');
        expect(await adapter.get('worker_settings_v1')).toBeNull();
    });
});
