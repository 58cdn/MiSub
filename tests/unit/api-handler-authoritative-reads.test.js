// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsCache, StorageFactory } from '../../functions/storage-adapter.js';
import { COLLECTIONS, deferred, makeD1, makeKV } from '../helpers/subscription-storage-fixtures.js';
import { handleDataRequest, handleMisubsSave } from '../../functions/modules/api-handler.js';
import { checkAndNotify } from '../../functions/modules/notifications.js';
import { clearAllNodeCaches } from '../../functions/services/node-cache-service.js';
import { maybeRunScheduledTasks } from '../../functions/modules/scheduled-task-runner.js';

vi.mock('../../functions/modules/notifications.js', () => ({
    checkAndNotify: vi.fn().mockResolvedValue(null),
    sendTgNotification: vi.fn(),
}));
vi.mock('../../functions/services/node-cache-service.js', () => ({
    clearAllNodeCaches: vi.fn().mockResolvedValue({ cleared: 0 }),
}));
vi.mock('../../functions/modules/scheduled-task-runner.js', () => ({
    maybeRunScheduledTasks: vi.fn().mockResolvedValue(null),
}));
const databases = [];
const sub = { id: 'sub-new', name: 'synthetic', enabled: true, url: 'https://fixture.invalid/sub' };
const profile = { id: 'group-new', subscriptions: [] };
const request = (mode) =>
    new Request('https://fixture.invalid/api/misubs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
            mode === 'diff'
                ? { diff: { subscriptions: { added: [sub] }, profiles: { added: [profile] } } }
                : { misubs: [sub], profiles: [profile] }
        ),
    });

beforeEach(() => {
    vi.clearAllMocks();
    SettingsCache.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
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
    SettingsCache.clear();
});
function createStorage(kind) {
    if (kind === 'kv') {
        const kv = makeKV({ misub_subscriptions_v1: '[]', misub_profiles_v1: '[]' });
        return {
            env: { MISUB_KV: kv },
            fail(table, loader) {
                const key = COLLECTIONS.find(([name]) => name === table)[1];
                kv.get.mockImplementation(async (input) =>
                    input === key ? loader() : (kv.store.get(input) ?? null)
                );
            },
            assertNoWrites() {
                expect(kv.put).not.toHaveBeenCalled();
                expect(kv.delete).not.toHaveBeenCalled();
            },
        };
    }
    const fixture = makeD1();
    databases.push(fixture.sqlite);
    return {
        ...fixture,
        env: { MISUB_DB: fixture.database },
        fail: (table, loader) => fixture.faults.set(table, loader),
        assertNoWrites: () => expect(fixture.writes).toEqual([]),
    };
}
function assertNoSideEffects(fixture) {
    fixture.assertNoWrites();
    expect(checkAndNotify).not.toHaveBeenCalled();
    expect(clearAllNodeCaches).not.toHaveBeenCalled();
    expect(maybeRunScheduledTasks).not.toHaveBeenCalled();
}

describe.each(['kv', 'd1'])('%s management read barriers', (kind) => {
    describe.each(['full', 'diff'])('%s saves', (mode) => {
        it.each(['subscriptions', 'profiles'])(
            'waits for %s read before any side effect, then fails closed',
            async (table) => {
                const fixture = createStorage(kind);
                const pendingRead = deferred();
                pendingRead.promise.catch(() => {});
                fixture.fail(table, () => pendingRead.promise);
                const saving = handleMisubsSave(request(mode), fixture.env);
                await new Promise((resolve) => setImmediate(resolve));
                let earlySideEffect;
                try {
                    assertNoSideEffects(fixture);
                } catch (error) {
                    earlySideEffect = error;
                }
                pendingRead.reject(new Error('sensitive-storage-detail'));
                const response = await saving;
                if (earlySideEffect) throw earlySideEffect;
                expect(response.status).toBe(503);
                expect(await response.json()).toMatchObject({
                    success: false,
                    code: 'STORAGE_COLLECTION_READ_FAILED',
                });
                assertNoSideEffects(fixture);
                expect(JSON.stringify(console.error.mock.calls)).not.toContain(
                    'sensitive-storage-detail'
                );
            }
        );
        it('allows a valid empty collection to receive the first saved item', async () => {
            const fixture = createStorage(kind);
            const response = await handleMisubsSave(request(mode), fixture.env);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                success: true,
                data: { misubs: [expect.objectContaining(sub)] },
            });
        });
    });

    it.each(['subscriptions', 'profiles'])(
        '/data returns sanitized failure when %s cannot be read',
        async (table) => {
            const fixture = createStorage(kind);
            fixture.fail(table, () => {
                throw new Error('sensitive-storage-detail');
            });
            const response = await handleDataRequest(fixture.env);
            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body).toMatchObject({ success: false, code: 'STORAGE_COLLECTION_READ_FAILED' });
            expect(body).not.toHaveProperty('misubs');
            expect(JSON.stringify(body)).not.toContain('sensitive-storage-detail');
            expect(JSON.stringify(console.error.mock.calls)).not.toContain(
                'sensitive-storage-detail'
            );
            assertNoSideEffects(fixture);
        }
    );
});

it.each(['full', 'diff'])('no binding cannot report a successful %s save', async (mode) => {
    const response = await handleMisubsSave(request(mode), {});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, code: 'STORAGE_UNAVAILABLE' });
    expect(checkAndNotify).not.toHaveBeenCalled();
});
it('no binding cannot present an empty successful management read', async () => {
    const response = await handleDataRequest({});
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, code: 'STORAGE_UNAVAILABLE' });
});

it.each(['full', 'diff'])(
    'D1 %s save reads the authoritative current collection instead of its warm cache',
    async (mode) => {
        const fixture = createStorage('d1');
        const adapter = StorageFactory.createAdapter(fixture.env, 'd1');
        await adapter.getAllSubscriptions();
        await adapter.getAllProfiles();
        fixture.sqlite
            .prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)')
            .run('existing', '{"id":"existing"}');
        const response = await handleMisubsSave(request(mode), fixture.env);
        expect(response.status).toBe(200);
        const actual = fixture.sqlite
            .prepare('SELECT id FROM subscriptions ORDER BY id')
            .all()
            .map(({ id }) => id);
        expect(actual).toEqual(mode === 'full' ? ['sub-new'] : ['existing', 'sub-new']);
        const payload = await response.json();
        expect(payload.data.misubs.map(({ id }) => id).sort()).toEqual(actual);
        // One cached read plus one preflight read; row synchronization must reuse it.
        expect(
            fixture.reads.filter((sql) => sql === 'SELECT data FROM subscriptions')
        ).toHaveLength(2);
        expect(fixture.reads.filter((sql) => sql === 'SELECT data FROM profiles')).toHaveLength(2);
    }
);

it('/data bypasses a warmed D1 collection cache', async () => {
    const fixture = createStorage('d1');
    const adapter = StorageFactory.createAdapter(fixture.env, 'd1');
    await adapter.getAllSubscriptions();
    fixture.fail('subscriptions', () => {
        throw new Error('database unavailable');
    });
    const response = await handleDataRequest(fixture.env);
    expect(response.status).toBe(503);
    assertNoSideEffects(fixture);
});

describe.each(['full', 'diff', 'data'])('%s binding selection', (mode) => {
    const run = (env) =>
        mode === 'data' ? handleDataRequest(env) : handleMisubsSave(request(mode), env);

    it.each(['kv', 'd1'])(
        'rejects missing selected %s binding even when another binding exists',
        async (selected) => {
            const kv = makeKV({ worker_settings_v1: '{"storageType":"d1"}' });
            const fixture = createStorage('d1');
            fixture.sqlite
                .prepare('UPDATE settings SET value = ? WHERE key = ?')
                .run('{"storageType":"kv"}', 'main');
            const env = selected === 'd1' ? { MISUB_KV: kv } : fixture.env;
            const response = await run(env);
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'STORAGE_UNAVAILABLE',
            });
            expect(kv.put).not.toHaveBeenCalled();
            assertNoSideEffects(fixture);
        }
    );

    it('does not switch to healthy KV collections when selected D1 fails', async () => {
        const fixture = createStorage('d1');
        const kv = makeKV({ misub_subscriptions_v1: '[]', misub_profiles_v1: '[]' });
        fixture.fail('subscriptions', () => {
            throw new Error('sensitive-storage-detail');
        });
        const response = await run({ ...fixture.env, MISUB_KV: kv });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
            success: false,
            code: 'STORAGE_COLLECTION_READ_FAILED',
        });
        expect(kv.get).not.toHaveBeenCalledWith('misub_subscriptions_v1');
        expect(kv.put).not.toHaveBeenCalled();
        assertNoSideEffects(fixture);
    });
});

describe.each(['full', 'diff', 'data'])('%s invalid stored data', (mode) => {
    it.each(COLLECTIONS)(
        'rejects malformed %s collection without notification or write',
        async (table, key) => {
            const kv = makeKV({
                misub_subscriptions_v1: '[]',
                misub_profiles_v1: '[]',
                [key]: '[{"name":"unidentified fixture"}]',
            });
            const env = { MISUB_KV: kv };
            const response = await (mode === 'data'
                ? handleDataRequest(env)
                : handleMisubsSave(request(mode), env));
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'STORAGE_COLLECTION_READ_FAILED',
            });
            expect(kv.put).not.toHaveBeenCalled();
            expect(checkAndNotify).not.toHaveBeenCalled();
            expect(maybeRunScheduledTasks).not.toHaveBeenCalled();
        }
    );
});

it('a failed save can be retried against the recovered KV collection', async () => {
    const kv = makeKV({ misub_subscriptions_v1: '[{"id":"original"}]', misub_profiles_v1: '[]' });
    let failCollection = true;
    kv.get.mockImplementation(async (key) => {
        if (key === 'misub_subscriptions_v1' && failCollection) throw new Error('read failed');
        return kv.store.get(key) ?? null;
    });
    const env = { MISUB_KV: kv };
    const failed = await handleMisubsSave(request('diff'), env);
    expect(failed.status).toBe(503);
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.store.get('misub_subscriptions_v1')).toBe('[{"id":"original"}]');
    failCollection = false;
    const recovered = await handleMisubsSave(request('diff'), env);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(kv.store.get('misub_subscriptions_v1')).map(({ id }) => id)).toEqual([
        'original',
        'sub-new',
    ]);
});

describe.each(['kv', 'd1'])('%s save input safety', (kind) => {
    describe.each(['misubs', 'profiles'])('%s collection', (collection) => {
        it.each([
            ['missing', {}],
            ['numeric', { id: 123 }],
            ['empty', { id: '' }],
            ['whitespace', { id: '  ' }],
            ['null item', null],
            ['string item', 'invalid'],
            ['array item', []],
        ])('rejects full-save %s ID/shape without poisoning later reads', async (_, item) => {
            const fixture = createStorage(kind);
            const body = { misubs: [sub], profiles: [profile], [collection]: [item] };
            const response = await handleMisubsSave(
                new Request('https://fixture.invalid/api/misubs', {
                    method: 'POST',
                    body: JSON.stringify(body),
                }),
                fixture.env
            );
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'INVALID_SUBSCRIPTION_DATA',
            });
            assertNoSideEffects(fixture);
            expect((await handleDataRequest(fixture.env)).status).toBe(200);
        });

        describe.each(['added', 'updated'])('diff %s', (operation) => {
            it.each([
                ['missing', {}],
                ['numeric', { id: 123 }],
                ['blank', { id: ' ' }],
                ['null item', null],
            ])('rejects %s ID before applyPatch can ignore the item', async (_, item) => {
                const fixture = createStorage(kind);
                const table = collection === 'misubs' ? 'subscriptions' : 'profiles';
                const body = {
                    diff: {
                        subscriptions: { added: [sub] },
                        profiles: { added: [profile] },
                        [table]: { [operation]: [item] },
                    },
                };
                const response = await handleMisubsSave(
                    new Request('https://fixture.invalid/api/misubs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                    }),
                    fixture.env
                );
                expect(response.status).toBe(400);
                expect(await response.json()).toMatchObject({
                    success: false,
                    code: 'INVALID_SUBSCRIPTION_DATA',
                });
                assertNoSideEffects(fixture);
                expect((await handleDataRequest(fixture.env)).status).toBe(200);
            });
        });

        it.each([null, 'id', [123], [' ']])(
            'rejects malformed diff removed %j before any side effect',
            async (removed) => {
                const fixture = createStorage(kind);
                const table = collection === 'misubs' ? 'subscriptions' : 'profiles';
                const body = {
                    diff: {
                        subscriptions: { added: [sub] },
                        profiles: { added: [profile] },
                        [table]: { removed },
                    },
                };
                const response = await handleMisubsSave(
                    new Request('https://fixture.invalid/api/misubs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                    }),
                    fixture.env
                );
                expect(response.status).toBe(400);
                expect(await response.json()).toMatchObject({
                    success: false,
                    code: 'INVALID_SUBSCRIPTION_DATA',
                });
                assertNoSideEffects(fixture);
            }
        );
    });
});

describe('save ID uniqueness', () => {
    describe.each(['kv', 'd1'])('%s storage', (kind) => {
        describe.each(COLLECTIONS)('%s', (table, key, method) => {
            it.each(['full', 'added', 'updated'])(
                'rejects duplicate IDs in %s without writes or notifications',
                async (operation) => {
                    const fixture = createStorage(kind);
                    const field = table === 'subscriptions' ? 'misubs' : 'profiles';
                    const items = [
                        { id: 'duplicate', name: 'first' },
                        { id: 'duplicate', name: 'second' },
                    ];
                    const body =
                        operation === 'full'
                            ? { misubs: [sub], profiles: [profile], [field]: items }
                            : {
                                  diff: {
                                      subscriptions: { added: [sub] },
                                      profiles: { added: [profile] },
                                      [table]: { [operation]: items },
                                  },
                              };
                    const response = await handleMisubsSave(
                        new Request('https://fixture.invalid/api/misubs', {
                            method: 'POST',
                            body: JSON.stringify(body),
                        }),
                        fixture.env
                    );
                    expect(response.status).toBe(400);
                    expect(await response.json()).toMatchObject({
                        success: false,
                        code: 'INVALID_SUBSCRIPTION_DATA',
                    });
                    assertNoSideEffects(fixture);
                }
            );

            it('preserves existing duplicate-ID storage read compatibility', async () => {
                const fixture = createStorage(kind);
                const items = [
                    { id: 'duplicate', name: 'first' },
                    { id: 'duplicate', name: 'second' },
                ];
                if (kind === 'kv') fixture.env.MISUB_KV.store.set(key, JSON.stringify(items));
                else
                    fixture.sqlite
                        .prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?)`)
                        .run('main', JSON.stringify(items));
                const adapter = StorageFactory.createAdapter(fixture.env, kind);
                expect(await adapter[method]({ authoritative: true })).toEqual(
                    kind === 'kv' ? items : [items[1]]
                );
                assertNoSideEffects(fixture);
            });

            it('accepts multiple distinct IDs and returns a usable saved collection', async () => {
                const fixture = createStorage(kind);
                const field = table === 'subscriptions' ? 'misubs' : 'profiles';
                const body = {
                    misubs: [sub],
                    profiles: [profile],
                    [field]: [{ id: 'first' }, { id: 'second' }],
                };
                const response = await handleMisubsSave(
                    new Request('https://fixture.invalid/api/misubs', {
                        method: 'POST',
                        body: JSON.stringify(body),
                    }),
                    fixture.env
                );
                expect(response.status).toBe(200);
                const payload = await response.json();
                expect(payload.data[field].map(({ id }) => id)).toEqual(['first', 'second']);
            });
        });
    });

    it.each(COLLECTIONS)(
        'rejects a final %s patch result that still contains legacy duplicate IDs',
        async (table, key) => {
            const fixture = createStorage('kv');
            const items = [
                { id: 'duplicate', name: 'first' },
                { id: 'duplicate', name: 'second' },
            ];
            fixture.env.MISUB_KV.store.set(key, JSON.stringify(items));
            const response = await handleMisubsSave(request('diff'), fixture.env);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'INVALID_SUBSCRIPTION_DATA',
            });
            assertNoSideEffects(fixture);
            expect(fixture.env.MISUB_KV.store.get(key)).toBe(JSON.stringify(items));
        }
    );
});
