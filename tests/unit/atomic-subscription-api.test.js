// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageFactory, SettingsCache } from '../../functions/storage-adapter.js';
import {
    createSubscriptionProtocol,
    protocolError,
} from '../../functions/services/subscription-protocol/index.js';
import { PROTOCOL_SCHEMA } from '../../functions/services/subscription-protocol/sql.js';
import {
    handleDataRequest,
    handleMisubsSave,
    handleSettingsSave,
    handleSettingsReset,
} from '../../functions/modules/api-handler.js';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { handleExternalSubscriptionsRequest } from '../../functions/modules/external-subscriptions-handler.js';
import { handleExternalManualNodesRequest } from '../../functions/modules/external-manual-nodes-handler.js';
import { handleExternalProfilesRequest } from '../../functions/modules/external-profiles-handler.js';
import {
    handleBackupRestore,
    handleWebdavRestore,
    handleWebdavBackupStatus,
    handleWebdavBackupTest,
    handleManualWebdavBackup,
    handleWebdavBackupList,
    restoreBackupPayload,
    buildBackupPayload,
} from '../../functions/modules/webdav-backup-handler.js';
import { checkAndNotify } from '../../functions/modules/notifications.js';
import { clearAllNodeCaches } from '../../functions/services/node-cache-service.js';
import { maybeRunScheduledTasks } from '../../functions/modules/scheduled-task-runner.js';
import { handleNodeCountRequest } from '../../functions/modules/handlers/node-handler.js';

vi.mock('../../functions/modules/notifications.js', () => ({
    checkAndNotify: vi.fn().mockResolvedValue(null),
    sendTgNotification: vi.fn(),
    handleCronTrigger: vi.fn(),
}));
vi.mock('../../functions/services/node-cache-service.js', () => ({
    clearAllNodeCaches: vi.fn().mockResolvedValue({ cleared: 0 }),
}));
vi.mock('../../functions/modules/scheduled-task-runner.js', () => ({
    maybeRunScheduledTasks: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../functions/modules/auth-middleware.js', async (actual) => ({
    ...(await actual()),
    authMiddleware: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../functions/modules/utils.js', async (actual) => ({
    ...(await actual()),
    isUsingDefaultPassword: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../functions/modules/handlers/node-handler.js', async (actual) => ({
    ...(await actual()),
    handleNodeCountRequest: vi
        .fn()
        .mockResolvedValue(
            new Response(JSON.stringify({ success: true, data: { count: 7, userInfo: null } }))
        ),
}));

const fixtures = [];
const baseVersion = { epoch: 'fixture_epoch', revision: 0 };
const metadata = { baseVersion, operationId: 'fixture_operation' };
const jsonRequest = (body, method = 'POST', path = '/api/misubs', headers = {}) =>
    new Request(`https://fixture.invalid${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

function createFixture() {
    const sqlite = new DatabaseSync(':memory:');
    fixtures.push(sqlite);
    sqlite.exec(
        'PRAGMA foreign_keys=ON; CREATE TABLE subscriptions(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE profiles(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);'
    );
    const subscriptions = [
        {
            id: 'sub_a',
            name: 'Remote',
            url: 'https://fixture.invalid/sub',
            enabled: true,
            _writeGeneration: 'generation_a',
            _observedAt: 0,
        },
        {
            id: 'node_a',
            name: 'Manual',
            url: 'trojan://synthetic@fixture.invalid:443',
            _writeGeneration: 'generation_b',
            _observedAt: 0,
        },
    ];
    const profiles = [
        { id: 'profile_group', name: 'Group', subscriptions: ['sub_a'], manualNodes: ['node_a'] },
    ];
    for (const item of subscriptions)
        sqlite.prepare('INSERT INTO subscriptions VALUES(?,?)').run(item.id, JSON.stringify(item));
    for (const item of profiles)
        sqlite.prepare('INSERT INTO profiles VALUES(?,?)').run(item.id, JSON.stringify(item));
    for (const sql of PROTOCOL_SCHEMA) sqlite.exec(sql);
    sqlite
        .prepare('INSERT INTO subscription_protocol_meta VALUES(1,?,1,?,0)')
        .run('fixture_authority', baseVersion.epoch);
    const db = {
        prepare(sql) {
            const prepared = (args = []) => ({
                sql,
                args,
                bind: (...values) => prepared(values),
                first: async () => sqlite.prepare(sql).get(...args) ?? null,
                all: async () => ({ success: true, results: sqlite.prepare(sql).all(...args) }),
                run: async () => {
                    sqlite.prepare(sql).run(...args);
                    return { success: true };
                },
            });
            return prepared();
        },
        batch: vi.fn(async (statements) => {
            sqlite.exec('BEGIN');
            try {
                const results = statements.map(({ sql, args }) => ({
                    success: true,
                    results: sqlite.prepare(sql).all(...args),
                }));
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        }),
    };
    const env = {
        MISUB_SUBSCRIPTION_PROTOCOL: 'd1-v1',
        MISUB_SUBSCRIPTION_AUTHORITY: 'fixture_authority',
        MISUB_DB: db,
    };
    const blocked = () =>
        vi.fn(async () => {
            throw new Error('legacy write must not execute');
        });
    const adapter = {
        type: 'd1',
        ...createSubscriptionProtocol(env),
        get: vi.fn(async () => null),
        put: blocked(),
        delete: blocked(),
        getAllSubscriptions: blocked(),
        getAllProfiles: blocked(),
        putSubscription: blocked(),
        putProfile: blocked(),
        deleteSubscriptionById: blocked(),
        deleteProfileById: blocked(),
    };
    const authoritativeSettings = StorageFactory.createAdapter(env, 'd1');
    vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('d1');
    vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(adapter);
    vi.spyOn(SettingsCache, 'get').mockResolvedValue({ storageType: 'd1' });
    return {
        env,
        adapter,
        db,
        sqlite,
        snapshot: () => adapter.readSubscriptionSnapshot(),
        setSettings: (settings) => authoritativeSettings.put('worker_settings_v1', settings),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw new Error('external network forbidden');
        })
    );
    handleNodeCountRequest.mockImplementation(
        async () =>
            new Response(JSON.stringify({ success: true, data: { count: 7, userInfo: null } }))
    );
});
afterEach(() => {
    for (const sqlite of fixtures.splice(0)) sqlite.close();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
function noLegacyWrites(adapter) {
    for (const key of [
        'put',
        'delete',
        'putSubscription',
        'putProfile',
        'deleteSubscriptionById',
        'deleteProfileById',
    ])
        expect(adapter[key]).not.toHaveBeenCalled();
}

describe('atomic management integration', () => {
    it('GET returns one snapshot version without profile ID migration or lazy writes', async () => {
        const { env, adapter } = createFixture();
        const read = vi.spyOn(adapter, 'readSubscriptionSnapshot');
        const response = await handleDataRequest(env);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            version: baseVersion,
            subscriptionProtocol: 'd1-v1',
            profiles: [{ id: 'profile_group' }],
        });
        expect(read).toHaveBeenCalledTimes(1);
        expect(adapter.getAllSubscriptions).not.toHaveBeenCalled();
        expect(adapter.getAllProfiles).not.toHaveBeenCalled();
        expect(maybeRunScheduledTasks).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    });
    it.each([{ misubs: [], profiles: [] }, { diff: { subscriptions: {} } }, { operations: [] }])(
        'rejects unversioned request %j with zero side effects',
        async (payload) => {
            const { env, adapter, db } = createFixture();
            const response = await handleMisubsSave(jsonRequest(payload), env);
            expect(response.status).toBe(428);
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'version_required',
            });
            expect(db.batch).not.toHaveBeenCalled();
            expect(clearAllNodeCaches).not.toHaveBeenCalled();
            expect(checkAndNotify).not.toHaveBeenCalled();
            noLegacyWrites(adapter);
        }
    );
    it('rejects a versioned full snapshot instead of silently translating it', async () => {
        const { env, db } = createFixture();
        const response = await handleMisubsSave(
            jsonRequest({ ...metadata, misubs: [], profiles: [] }),
            env
        );
        expect(response.status).toBe(428);
        expect(await response.json()).toMatchObject({ code: 'legacy_write_blocked' });
        expect(db.batch).not.toHaveBeenCalled();
    });
    it('commits explicit operations, returns receipt, and suppresses replay effects', async () => {
        const { env, adapter, snapshot } = createFixture();
        const payload = {
            ...metadata,
            operations: [
                {
                    type: 'update',
                    collection: 'subscriptions',
                    id: 'sub_a',
                    fields: { name: 'Edited' },
                },
            ],
        };
        const first = await handleMisubsSave(jsonRequest(payload), env);
        const body = await first.json();
        expect(first.status).toBe(200);
        expect(body.data.version).toEqual({ ...baseVersion, revision: 1 });
        expect(body.receipt.operationId).toBe(metadata.operationId);
        expect(body.replayed).toBe(false);
        expect(clearAllNodeCaches).toHaveBeenCalledTimes(1);
        const again = await handleMisubsSave(jsonRequest(payload), env);
        expect((await again.json()).replayed).toBe(true);
        expect(clearAllNodeCaches).toHaveBeenCalledTimes(1);
        expect((await snapshot()).subscriptions.find(({ id }) => id === 'sub_a').name).toBe(
            'Edited'
        );
        noLegacyWrites(adapter);
    });
    it.each([
        'revision_conflict',
        'epoch_conflict',
        'operation_id_conflict',
        'authority_mismatch',
        'schema_not_ready',
    ])('maps %s without exposing raw storage details', async (code) => {
        const { env, adapter } = createFixture();
        adapter.commitSubscriptionOperations = vi
            .fn()
            .mockRejectedValue(Object.assign(new Error('synthetic-secret-detail'), { code }));
        const response = await handleMisubsSave(jsonRequest({ ...metadata, operations: [] }), env);
        expect(response.status).toBe(code.includes('conflict') ? 409 : 503);
        expect(await response.text()).not.toContain('synthetic-secret-detail');
        expect(checkAndNotify).not.toHaveBeenCalled();
        expect(clearAllNodeCaches).not.toHaveBeenCalled();
    });
    it('unknown backend failure becomes a sanitized 503', async () => {
        const { env, adapter } = createFixture();
        adapter.readSubscriptionSnapshot = vi
            .fn()
            .mockRejectedValue(new Error('synthetic-secret-detail'));
        const response = await handleDataRequest(env);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'storage_unavailable' });
    });
});

const routes = [
    [
        'subscription',
        handleExternalSubscriptionsRequest,
        { id: 'created_sub', name: 'Created', url: 'https://fixture.invalid/new' },
        'sub_a',
    ],
    [
        'manual',
        handleExternalManualNodesRequest,
        { id: 'created_node', name: 'Created', url: 'trojan://fixture@fixture.invalid:443' },
        'node_a',
    ],
    [
        'profile',
        (request, env, id = null) => handleExternalProfilesRequest(request, env, { id }),
        { id: 'created_profile', name: 'Created', subscriptionIds: ['sub_a'], manualNodeIds: [] },
        'profile_group',
    ],
];
describe.each(routes)('atomic external %s', (_, handler, createPayload, id) => {
    it('returns a usable version for list and detail reads', async () => {
        const { env, adapter } = createFixture();
        for (const target of [null, id]) {
            const response = await handler(jsonRequest(undefined, 'GET'), env, target);
            expect(response.status).toBe(200);
            expect((await response.json()).meta).toMatchObject({
                version: baseVersion,
                subscriptionProtocol: 'd1-v1',
            });
        }
        noLegacyWrites(adapter);
    });
    it('requires client metadata for create and delete', async () => {
        const { env, db } = createFixture();
        expect((await handler(jsonRequest(createPayload), env)).status).toBe(428);
        expect((await handler(jsonRequest(undefined, 'DELETE'), env, id)).status).toBe(428);
        expect(db.batch).not.toHaveBeenCalled();
    });
    it('uses stable create operations and returns the original receipt on retry', async () => {
        const { env, adapter } = createFixture();
        const payload = { ...metadata, ...createPayload };
        const first = await handler(jsonRequest(payload), env);
        const a = await first.json();
        expect(first.status).toBe(201);
        expect(a.data.id).toBe(createPayload.id);
        const again = await handler(jsonRequest(payload), env);
        const b = await again.json();
        expect(again.status).toBe(201);
        expect(b.meta.replayed).toBe(true);
        expect(b.meta.receipt).toEqual(a.meta.receipt);
        noLegacyWrites(adapter);
    });
    it('DELETE headers commit removal and profile reference cleanup in one transaction', async () => {
        const { env, adapter, snapshot } = createFixture();
        const response = await handler(
            jsonRequest(undefined, 'DELETE', '/api/ext/v1/item', {
                'X-MiSub-Epoch': baseVersion.epoch,
                'X-MiSub-Revision': '0',
                'X-MiSub-Operation-Id': metadata.operationId,
            }),
            env,
            id
        );
        expect(response.status).toBe(200);
        const state = await snapshot();
        expect(state.version.revision).toBe(1);
        expect([...state.subscriptions, ...state.profiles].some((item) => item.id === id)).toBe(
            false
        );
        expect(
            state.profiles.every(
                (profile) =>
                    !profile.subscriptions.includes(id) && !profile.manualNodes.includes(id)
            )
        ).toBe(true);
        noLegacyWrites(adapter);
    });
    it('PATCH commits only the requested fields and rejects a stale follow-up', async () => {
        const { env, adapter, snapshot } = createFixture();
        const response = await handler(
            jsonRequest({ ...metadata, name: 'Edited' }, 'PATCH'),
            env,
            id
        );
        expect(response.status).toBe(200);
        const state = await snapshot();
        expect(
            [...state.subscriptions, ...state.profiles].find((item) => item.id === id).name
        ).toBe('Edited');
        const stale = await handler(
            jsonRequest({ ...metadata, operationId: 'stale_operation', name: 'Stale' }, 'PATCH'),
            env,
            id
        );
        expect(stale.status).toBe(409);
        expect((await stale.json()).error.code).toBe('revision_conflict');
        expect((await snapshot()).version.revision).toBe(1);
        noLegacyWrites(adapter);
    });
    it('rejects forged runtime fields before persistence', async () => {
        const { env, db } = createFixture();
        const response = await handler(
            jsonRequest({ ...metadata, ...createPayload, nodeCount: 999 }),
            env
        );
        expect(response.status).toBe(400);
        expect(db.batch).not.toHaveBeenCalled();
    });
});

it('atomic external profile links and unlinks preserve the independent reference field', async () => {
    const { env, snapshot, adapter } = createFixture();
    const unlink = await handleExternalProfilesRequest(
        jsonRequest({ ...metadata, subscriptionIds: ['sub_a'] }, 'DELETE'),
        env,
        { id: 'profile_group', relation: 'subscriptions' }
    );
    expect(unlink.status).toBe(200);
    expect((await snapshot()).profiles[0]).toMatchObject({
        subscriptions: [],
        manualNodes: ['node_a'],
    });
    const link = await handleExternalProfilesRequest(
        jsonRequest({
            operationId: 'link_again',
            baseVersion: { ...baseVersion, revision: 1 },
            subscriptionIds: ['sub_a'],
        }),
        env,
        { id: 'profile_group', relation: 'subscriptions' }
    );
    expect(link.status).toBe(200);
    expect((await snapshot()).profiles[0]).toMatchObject({
        subscriptions: ['sub_a'],
        manualNodes: ['node_a'],
    });
    noLegacyWrites(adapter);
});

it.each([
    [{ ...metadata, id: 'new_group', name: 'Group', subscriptionIds: ['node_a'] }, 'POST', {}],
    [{ ...metadata, manualNodeIds: ['sub_a'] }, 'PATCH', { id: 'profile_group' }],
    [
        { ...metadata, subscriptionIds: ['node_a'] },
        'POST',
        { id: 'profile_group', relation: 'subscriptions' },
    ],
])(
    'rejects mismatched external profile reference types before commit',
    async (payload, method, options) => {
        const { env, adapter, db } = createFixture();
        const response = await handleExternalProfilesRequest(
            jsonRequest(payload, method),
            env,
            options
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('invalid_reference');
        expect(db.batch).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    }
);

it('atomic external configuration aliases map to canonical editable fields', async () => {
    const { env, snapshot } = createFixture();
    const response = await handleExternalSubscriptionsRequest(
        jsonRequest(
            {
                ...metadata,
                userAgent: 'SyntheticAgent',
                proxy: 'https://proxy.fixture.invalid',
                tags: ['fixture'],
            },
            'PATCH'
        ),
        env,
        'sub_a'
    );
    expect(response.status).toBe(200);
    const item = (await snapshot()).subscriptions.find(({ id }) => id === 'sub_a');
    expect(item).toMatchObject({
        customUserAgent: 'SyntheticAgent',
        fetchProxy: 'https://proxy.fixture.invalid',
        tags: ['fixture'],
    });
    expect(item).not.toHaveProperty('userAgent');
    expect(item).not.toHaveProperty('proxy');
});

describe('atomic restore and migration guards', () => {
    it.each([
        ['status', (_, env) => handleWebdavBackupStatus(env), 'GET'],
        ['test', handleWebdavBackupTest, 'POST'],
        ['backup', handleManualWebdavBackup, 'POST'],
        ['list', handleWebdavBackupList, 'GET'],
    ])(
        'sanitizes WebDAV %s storage errors before any network action',
        async (_, handler, method) => {
            const { env, adapter } = createFixture();
            adapter.get.mockRejectedValue(new Error('synthetic_private_store_details'));
            const response = await handler(
                jsonRequest(method === 'GET' ? undefined : {}, method),
                env
            );
            expect(response.status).toBe(503);
            const body = await response.json();
            expect(body.code).toBe('storage_unavailable');
            expect(JSON.stringify(body)).not.toContain('synthetic_private_store_details');
            noLegacyWrites(adapter);
        }
    );
    it('requires metadata before fetching a remote restore file', async () => {
        const { env, adapter, db } = createFixture();
        const response = await handleWebdavRestore(
            jsonRequest({ scope: 'subscriptions-only', file: '/fixture.json' }),
            env
        );
        expect(response.status).toBe(428);
        expect(await response.json()).toMatchObject({ code: 'version_required' });
        expect(db.batch).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    });
    it('rejects multidomain restore before creating a snapshot or writing settings', async () => {
        const { env, adapter, db } = createFixture();
        const response = await handleBackupRestore(
            jsonRequest({
                payload: { data: { subscriptions: [], profiles: [], settings: {} } },
                ...metadata,
            }),
            env
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'unsupported_restore_scope' });
        expect(db.batch).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    });
    it.each([
        { subscriptions: [] },
        { profiles: [] },
        { subscriptions: [], profiles: [], ruleTemplates: [] },
    ])('rejects incomplete/multidomain raw restore %j', async (data) => {
        const { env, db } = createFixture();
        await expect(
            restoreBackupPayload(
                env,
                { data },
                { ...metadata, nextEpoch: 'next_epoch', scope: 'subscriptions-only' }
            )
        ).rejects.toMatchObject({ code: 'invalid_data' });
        expect(db.batch).not.toHaveBeenCalled();
    });
    it('restores both explicit collections under a new epoch atomically', async () => {
        const { env, adapter, snapshot } = createFixture();
        const response = await handleBackupRestore(
            jsonRequest({
                ...metadata,
                nextEpoch: 'next_epoch',
                scope: 'subscriptions-only',
                payload: {
                    subscriptions: [
                        {
                            id: 'restored',
                            name: 'Restored',
                            url: 'https://fixture.invalid/restored',
                        },
                    ],
                    profiles: [
                        { id: 'restored_group', subscriptions: ['restored'], manualNodes: [] },
                    ],
                },
            }),
            env
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data.version).toEqual({ epoch: 'next_epoch', revision: 0 });
        expect((await snapshot()).profiles[0].subscriptions).toEqual(['restored']);
        noLegacyWrites(adapter);
    });
    it('exports collections from one atomic snapshot and labels its version', async () => {
        const { env, adapter } = createFixture();
        const read = vi.spyOn(adapter, 'readSubscriptionSnapshot');
        const payload = await buildBackupPayload(env);
        expect(payload.source.subscriptionVersion).toEqual(baseVersion);
        expect(read).toHaveBeenCalledTimes(1);
        noLegacyWrites(adapter);
    });
    it.each(['/migrate', '/migrate_to_d1', '/migrate_legacy_d1'])(
        'blocks the legacy online migration %s',
        async (path) => {
            const { env, adapter, db } = createFixture();
            const response = await handleApiRequest(jsonRequest({}, 'POST', `/api${path}`), env);
            expect(response.status).toBe(428);
            expect(db.batch).not.toHaveBeenCalled();
            noLegacyWrites(adapter);
        }
    );
    it('blocks storage fallback and settings reset', async () => {
        const { env, adapter, db } = createFixture();
        expect((await handleSettingsSave(jsonRequest({ storageType: 'kv' }), env)).status).toBe(
            428
        );
        expect((await handleSettingsReset(env)).status).toBe(428);
        expect(db.batch).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    });
    it('saves strict settings only in its authoritative D1 adapter', async () => {
        const { env, adapter, db } = createFixture();
        adapter.put.mockResolvedValue(true);
        const response = await handleSettingsSave(
            jsonRequest({ storageType: 'd1', defaultLocale: 'en-US' }, 'POST', '/api/settings', {
                'X-MiSub-Save-Scope': 'preferences',
            }),
            env
        );
        expect(response.status).toBe(200);
        expect(StorageFactory.createAdapter).toHaveBeenCalledTimes(1);
        expect(adapter.put).toHaveBeenCalledTimes(1);
        expect(adapter.put.mock.calls[0][1]).toMatchObject({
            storageType: 'd1',
            defaultLocale: 'en-US',
        });
        expect(db.batch).not.toHaveBeenCalled();
    });
    it('sanitizes a strict settings storage failure', async () => {
        const { env, adapter } = createFixture();
        adapter.put.mockRejectedValue(new Error('synthetic_private_store_details'));
        const response = await handleSettingsSave(jsonRequest({ defaultLocale: 'en-US' }), env);
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.code).toBe('storage_unavailable');
        expect(JSON.stringify(body)).not.toContain('synthetic_private_store_details');
    });
    it('sanitizes an external authentication settings storage failure', async () => {
        const { env } = createFixture();
        StorageFactory.createAdapter.mockImplementation(() => {
            throw new Error('synthetic_private_store_details');
        });
        const response = await handleApiRequest(
            new Request('https://fixture.invalid/api/ext/v1/subscriptions'),
            env
        );
        expect(response.status).toBe(503);
        const body = await response.json();
        expect(body.error.code).toBe('storage_unavailable');
        expect(JSON.stringify(body)).not.toContain('synthetic_private_store_details');
    });
});

describe('atomic external inspection and refresh', () => {
    it('refreshes a profile through its remote references without editing the manual nodes', async () => {
        const { env, adapter, snapshot } = createFixture();
        const response = await handleExternalProfilesRequest(jsonRequest(metadata), env, {
            id: 'profile_group',
            action: 'refresh',
        });
        expect(response.status).toBe(200);
        expect((await response.json()).data.results).toHaveLength(1);
        expect(handleNodeCountRequest).toHaveBeenCalledTimes(1);
        const state = await snapshot();
        expect(state.subscriptions.find(({ id }) => id === 'node_a')).not.toHaveProperty(
            'nodeCount'
        );
        expect(state.profiles[0]).toMatchObject({
            subscriptions: ['sub_a'],
            manualNodes: ['node_a'],
        });
        noLegacyWrites(adapter);
    });
    it.each(['GET', 'PATCH', 'DELETE'])(
        'rejects refresh method %s before inspection',
        async (method) => {
            const { env, db } = createFixture();
            const response = await handleExternalSubscriptionsRequest(
                jsonRequest(method === 'GET' ? undefined : metadata, method),
                env,
                {
                    id: 'sub_a',
                    action: 'refresh',
                }
            );
            expect(response.status).toBe(405);
            expect(handleNodeCountRequest).not.toHaveBeenCalled();
            expect(db.batch).not.toHaveBeenCalled();
        }
    );
    it('uses the captured global TLS policy for inspection and its observation commit', async () => {
        const { env, setSettings, snapshot } = createFixture();
        await setSettings({ builtinSkipCertVerify: true });
        const response = await handleExternalSubscriptionsRequest(jsonRequest(metadata), env, {
            id: 'sub_a',
            action: 'refresh',
        });
        expect(response.status).toBe(200);
        expect(handleNodeCountRequest.mock.calls[0][2]).toEqual({ requestPolicy: 1 });
        expect((await snapshot()).subscriptions.find(({ id }) => id === 'sub_a').nodeCount).toBe(7);
    });
    it('refuses a runtime observation when global TLS policy changes during inspection', async () => {
        const { env, setSettings, snapshot } = createFixture();
        handleNodeCountRequest.mockImplementationOnce(async () => {
            await setSettings({ builtinSkipCertVerify: true });
            return new Response(JSON.stringify({ success: true, data: { count: 77 } }));
        });
        const response = await handleExternalSubscriptionsRequest(jsonRequest(metadata), env, {
            id: 'sub_a',
            action: 'refresh',
        });
        expect(handleNodeCountRequest.mock.calls[0][2]).toEqual({ requestPolicy: 0 });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('identity_conflict');
        expect(
            (await snapshot()).subscriptions.find(({ id }) => id === 'sub_a')
        ).not.toHaveProperty('nodeCount');
    });
    it('validate sends inspection-only and performs no protocol commit', async () => {
        const { env, adapter, db } = createFixture();
        const response = await handleExternalSubscriptionsRequest(
            jsonRequest({ url: 'https://fixture.invalid/check' }),
            env,
            { action: 'validate' }
        );
        expect(response.status).toBe(200);
        expect(await handleNodeCountRequest.mock.calls[0][0].json()).toMatchObject({
            inspectOnly: true,
        });
        expect(db.batch).not.toHaveBeenCalled();
        noLegacyWrites(adapter);
    });
    it('versionless refresh is rejected before inspection', async () => {
        const { env } = createFixture();
        const response = await handleExternalSubscriptionsRequest(jsonRequest({}), env, {
            id: 'sub_a',
            action: 'refresh',
        });
        expect(response.status).toBe(428);
        expect(handleNodeCountRequest).not.toHaveBeenCalled();
    });
    it('refresh writes only runtime fields through the identity-checked commit', async () => {
        const { env, adapter, snapshot } = createFixture();
        const response = await handleExternalSubscriptionsRequest(jsonRequest(metadata), env, {
            id: 'sub_a',
            action: 'refresh',
        });
        expect(response.status).toBe(200);
        expect(await handleNodeCountRequest.mock.calls[0][0].json()).toMatchObject({
            inspectOnly: true,
        });
        const item = (await snapshot()).subscriptions.find(({ id }) => id === 'sub_a');
        expect(item).toMatchObject({
            nodeCount: 7,
            name: 'Remote',
            url: 'https://fixture.invalid/sub',
        });
        noLegacyWrites(adapter);
    });
    it('a concurrent URL edit prevents stale inspection from writing runtime data', async () => {
        const { env, adapter, snapshot } = createFixture();
        handleNodeCountRequest.mockImplementationOnce(async () => {
            await adapter.commitSubscriptionOperations({
                ...metadata,
                operationId: 'concurrent_edit',
                operations: [
                    {
                        type: 'update',
                        collection: 'subscriptions',
                        id: 'sub_a',
                        fields: { url: 'https://fixture.invalid/changed' },
                    },
                ],
            });
            return new Response(JSON.stringify({ success: true, data: { count: 77 } }));
        });
        const response = await handleExternalSubscriptionsRequest(jsonRequest(metadata), env, {
            id: 'sub_a',
            action: 'refresh',
        });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('identity_conflict');
        expect(
            (await snapshot()).subscriptions.find(({ id }) => id === 'sub_a')
        ).not.toHaveProperty('nodeCount');
        noLegacyWrites(adapter);
    });
    it('retains each batch receipt when a later observation conflicts', async () => {
        const { env, adapter, snapshot } = createFixture();
        await adapter.commitSubscriptionOperations({
            ...metadata,
            operationId: 'create_second',
            operations: [
                {
                    type: 'create',
                    collection: 'subscriptions',
                    item: { id: 'sub_b', name: 'Second', url: 'https://fixture.invalid/second' },
                },
            ],
        });
        handleNodeCountRequest.mockImplementationOnce(
            async () => new Response(JSON.stringify({ success: true, data: { count: 7 } }))
        );
        handleNodeCountRequest.mockImplementationOnce(async () => {
            await adapter.commitSubscriptionOperations({
                operationId: 'edit_second',
                baseVersion: (await snapshot()).version,
                operations: [
                    {
                        type: 'update',
                        collection: 'subscriptions',
                        id: 'sub_b',
                        fields: { url: 'https://fixture.invalid/replaced' },
                    },
                ],
            });
            return new Response(JSON.stringify({ success: true, data: { count: 77 } }));
        });
        const response = await handleExternalSubscriptionsRequest(
            jsonRequest({
                operationId: 'batch_refresh',
                baseVersion: { ...baseVersion, revision: 1 },
                subscriptionIds: ['sub_a', 'sub_b'],
            }),
            env,
            { action: 'batch_refresh' }
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.data.results[0]).toMatchObject({
            id: 'sub_a',
            applied: true,
            receipt: { version: { revision: 2 } },
        });
        expect(body.data.results[1]).toMatchObject({
            id: 'sub_b',
            applied: false,
            error: { code: 'identity_conflict' },
        });
        expect(
            (await snapshot()).subscriptions.find(({ id }) => id === 'sub_b')
        ).not.toHaveProperty('nodeCount');
        noLegacyWrites(adapter);
    });
});
