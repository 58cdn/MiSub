import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { commitObservation, sendNotification } = vi.hoisted(() => ({
    commitObservation: vi.fn(),
    sendNotification: vi.fn(),
}));
vi.mock('../../functions/services/subscription-protocol/index.js', async (load) => ({
    ...(await load()),
    commitRuntimeObservation: commitObservation,
}));
vi.mock('../../functions/services/notification-service.js', () => ({
    sendTgNotification: sendNotification,
    sendEnhancedTgNotification: vi.fn(),
    tgEscape: (value) => value,
}));

import { StorageFactory } from '../../functions/storage-adapter.js';
import {
    captureSubscriptionIdentity,
    protocolError,
} from '../../functions/services/subscription-protocol/index.js';
import { applyObservation } from '../../functions/services/subscription-protocol/operations.js';
import {
    handleNodeCountRequest,
    handleBatchUpdateNodesRequest,
} from '../../functions/modules/handlers/node-handler.js';
import { handleCronTrigger } from '../../functions/modules/notifications.js';
import { generateCombinedNodeList } from '../../functions/services/subscription-service.js';
import { handleMisubRequest } from '../../functions/modules/subscription/main-handler.js';
import { handleTelegramWebhook } from '../../functions/modules/handlers/telegram-webhook-handler.js';
import {
    performSubscriptionSync,
    onRequest as legacyScheduleRequest,
} from '../../functions/_schedule.js';

const node = 'trojan://synthetic@example.com:443#Fixture';
function request(body) {
    return new Request('https://misub.invalid/api/node_count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
function fixture(
    subscriptions = [
        {
            id: 'one',
            url: 'https://source.example/sub',
            enabled: true,
            _writeGeneration: 'generation-1',
        },
    ]
) {
    const state = {
        requestPolicy: 0,
        version: { epoch: 'fixture-epoch', revision: 4 },
        subscriptions,
        profiles: [],
    };
    const settings = {
        telegram_push_config: {
            enabled: true,
            bot_token: 'synthetic-token',
            webhook_secret: 'synthetic-secret',
            allowed_user_ids: ['1'],
        },
    };
    const storage = {
        subscriptionProtocol: 'd1-v1',
        readSubscriptionSnapshot: vi.fn(async () => structuredClone(state)),
        get: vi.fn(async (key) => (key === 'worker_settings_v1' ? settings : null)),
        put: vi.fn(),
        putAllSubscriptions: vi.fn(),
        putAllProfiles: vi.fn(),
        updateSubscriptionById: vi.fn(),
        getAllSubscriptions: vi.fn(async () => structuredClone(state.subscriptions)),
        getAllProfiles: vi.fn(async () => structuredClone(state.profiles)),
        getSubscriptionsByIds: vi.fn(),
    };
    vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('d1');
    vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue(storage);
    // This mock validates writer identity and fields; SQL atomicity is tested separately.
    commitObservation.mockImplementation(async (_storage, observation) => {
        try {
            const next = await applyObservation(state, observation);
            Object.assign(state, next, {
                version: { ...state.version, revision: state.version.revision + 1 },
            });
            return {
                applied: true,
                replayed: false,
                snapshot: structuredClone(state),
                receipt: {},
            };
        } catch (error) {
            return { applied: false, reason: error.code };
        }
    });
    return { state, settings, storage };
}
function metadata(state) {
    return {
        subscriptionId: 'one',
        baseVersion: structuredClone(state.version),
        operationId: 'synthetic-observation',
    };
}
function expectNoLegacyWrite(storage) {
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.putAllSubscriptions).not.toHaveBeenCalled();
    expect(storage.putAllProfiles).not.toHaveBeenCalled();
    expect(storage.updateSubscriptionById).not.toHaveBeenCalled();
}

beforeEach(() => {
    commitObservation.mockReset();
    sendNotification.mockReset().mockResolvedValue(false);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(node))
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('strict node observations', () => {
    it('captures the authoritative identity before network and returns the committed snapshot', async () => {
        const { state, storage } = fixture();
        const identity = await captureSubscriptionIdentity(state.subscriptions[0]);
        const input = { ...metadata(state), url: 'https://untrusted.example/ignored' };
        const response = await handleNodeCountRequest(request(input), {});
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            applied: true,
            subscriptionSnapshot: { version: { revision: 5 } },
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls.every(([req]) => req.url === 'https://source.example/sub')).toBe(
            true
        );
        expect(commitObservation).toHaveBeenCalledWith(
            storage,
            expect.objectContaining({
                identity,
                id: 'one',
                operationId: input.operationId,
                fields: expect.objectContaining({ nodeCount: 1, lastError: null }),
            })
        );
        expectNoLegacyWrite(storage);
    });
    it.each([
        ['missing metadata', {}, 428],
        [
            'old revision',
            {
                subscriptionId: 'one',
                baseVersion: { epoch: 'fixture-epoch', revision: 3 },
                operationId: 'old',
            },
            409,
        ],
        [
            'old epoch',
            {
                subscriptionId: 'one',
                baseVersion: { epoch: 'old', revision: 4 },
                operationId: 'old',
            },
            409,
        ],
        [
            'missing target',
            {
                subscriptionId: 'gone',
                baseVersion: { epoch: 'fixture-epoch', revision: 4 },
                operationId: 'gone',
            },
            409,
        ],
    ])('rejects %s before fetching', async (_label, body, status) => {
        const { storage } = fixture();
        const response = await handleNodeCountRequest(request(body), {});
        expect(response.status).toBe(status);
        expect(fetch).not.toHaveBeenCalled();
        expect(commitObservation).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it.each(['deleted', 'changed_url', 'recreated', 'newer_observation'])(
        'rejects an in-flight %s result',
        async (mutation) => {
            const { state, storage } = fixture();
            const input = metadata(state);
            fetch.mockImplementation(async () => {
                if (mutation === 'deleted') state.subscriptions = [];
                else if (mutation === 'changed_url')
                    state.subscriptions[0].url = 'https://changed.example/sub';
                else if (mutation === 'recreated')
                    state.subscriptions[0]._writeGeneration = 'new-generation';
                else state.subscriptions[0]._observationTimes = { nodeCount: Date.now() + 60000 };
                return new Response(node);
            });
            const response = await handleNodeCountRequest(request(input), {});
            expect(response.status).toBe(409);
            expect((await response.json()).applied).toBe(false);
            expect(state.subscriptions[0]?.nodeCount).toBeUndefined();
            expectNoLegacyWrite(storage);
        }
    );
    it('inspection fetches without writing even when the URL matches stored data', async () => {
        const { storage } = fixture();
        const response = await handleNodeCountRequest(
            request({ url: 'https://source.example/sub', inspectOnly: true }),
            {}
        );
        expect((await response.json()).success).toBe(true);
        expect(commitObservation).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('fails authoritative reads before fetching', async () => {
        const { state, storage } = fixture();
        storage.readSubscriptionSnapshot.mockRejectedValue(protocolError('storage_unavailable'));
        const response = await handleNodeCountRequest(request(metadata(state)), {});
        expect(response.status).toBe(503);
        expect(fetch).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('does not turn an unknown commit outcome into success or a legacy write', async () => {
        const { state, storage } = fixture();
        commitObservation.mockRejectedValue(protocolError('storage_unavailable'));
        const response = await handleNodeCountRequest(request(metadata(state)), {});
        expect(response.status).toBe(503);
        expect((await response.json()).success).toBe(false);
        expect(commitObservation).toHaveBeenCalledTimes(1);
        expectNoLegacyWrite(storage);
    });
    it('missing captured request policy is rejected before fetching', async () => {
        const { state, storage } = fixture();
        delete state.requestPolicy;
        const response = await handleNodeCountRequest(request(metadata(state)), {});
        expect(response.status).toBe(503);
        expect(fetch).not.toHaveBeenCalled();
        expect(commitObservation).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it.each([0, 1])('uses captured TLS policy %s without another settings read', async (policy) => {
        const { state, storage } = fixture();
        state.requestPolicy = policy;
        storage.get.mockRejectedValue(new Error('must not read separate settings'));
        const response = await handleNodeCountRequest(request(metadata(state)), {});
        expect(response.status).toBe(200);
        expect(
            fetch.mock.calls.every(
                ([, options]) => Boolean(options.cf?.insecureSkipVerify) === (policy === 1)
            )
        ).toBe(true);
        expect(commitObservation.mock.calls[0][1].requestPolicy).toBe(policy);
        expect(storage.get).not.toHaveBeenCalled();
    });
    it('preserves the known count for suspicious truncated responses', async () => {
        const { state, storage } = fixture();
        state.subscriptions[0].nodeCount = 50;
        const response = await handleNodeCountRequest(request(metadata(state)), {});
        expect(await response.json()).toMatchObject({
            applied: false,
            reason: 'observation_protected',
            data: { count: 50 },
        });
        expect(commitObservation).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('batch inspection reads the coherent snapshot and never persists it', async () => {
        const { storage } = fixture();
        const response = await handleBatchUpdateNodesRequest(
            request({ subscriptionIds: ['one'] }),
            {}
        );
        expect((await response.json()).success).toBe(true);
        expect(storage.readSubscriptionSnapshot).toHaveBeenCalledTimes(1);
        expect(storage.get).not.toHaveBeenCalledWith('misub_subscriptions_v1');
        expect(commitObservation).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
});

describe('strict Cron and download writers', () => {
    it('schedule HTTP rejects a forged platform header before fetching', async () => {
        fixture();
        const response = await legacyScheduleRequest({
            request: new Request('https://misub.invalid/_schedule', {
                headers: { 'CF-Cron': 'true' },
            }),
            env: {},
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Cron commits runtime observations before notifications and never persists a full list', async () => {
        const { state, storage } = fixture();
        fetch.mockImplementation(
            async () =>
                new Response(node, {
                    headers: { 'subscription-userinfo': 'upload=9; download=1; total=10' },
                })
        );
        sendNotification.mockImplementation(async () => {
            expect(state.subscriptions[0].nodeCount).toBe(1);
            return true;
        });
        const response = await handleCronTrigger({});
        expect((await response.json()).summary).toMatchObject({ updated: 1, failed: 0 });
        expect(commitObservation).toHaveBeenCalledTimes(2);
        expect(commitObservation.mock.calls[1][1].fields).toHaveProperty('lastNotifiedTraffic');
        expect(sendNotification).toHaveBeenCalledTimes(1);
        expectNoLegacyWrite(storage);
    });
    it('Cron read failure has no network or notification side effects', async () => {
        const { storage } = fixture();
        storage.readSubscriptionSnapshot.mockRejectedValue(protocolError('storage_unavailable'));
        await expect(handleCronTrigger({})).rejects.toMatchObject({ code: 'storage_unavailable' });
        expect(fetch).not.toHaveBeenCalled();
        expect(sendNotification).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('Cron commit failure prevents subsequent business notifications', async () => {
        const { storage } = fixture();
        commitObservation.mockRejectedValue(protocolError('storage_unavailable'));
        await expect(handleCronTrigger({})).rejects.toMatchObject({ code: 'storage_unavailable' });
        expect(sendNotification).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('Cron settings failure aborts before fetching or notifications', async () => {
        const { storage } = fixture();
        storage.get.mockRejectedValue(protocolError('storage_unavailable'));
        await expect(handleCronTrigger({})).rejects.toMatchObject({ code: 'storage_unavailable' });
        expect(fetch).not.toHaveBeenCalled();
        expect(commitObservation).not.toHaveBeenCalled();
        expect(sendNotification).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('Cron ignores results for subscriptions removed in flight', async () => {
        const { state, storage } = fixture();
        fetch.mockImplementation(async () => {
            state.subscriptions = [];
            return new Response(node);
        });
        const response = await handleCronTrigger({});
        expect((await response.json()).summary).toMatchObject({ updated: 0, failed: 1 });
        expect(sendNotification).not.toHaveBeenCalled();
        expect(state.subscriptions).toEqual([]);
        expectNoLegacyWrite(storage);
    });
    it('download waitUntil rejects a canonical observation after its URL changes', async () => {
        const { state, storage } = fixture();
        const source = structuredClone(state.subscriptions[0]);
        const pending = [];
        const context = { storage, waitUntil: (promise) => pending.push(promise) };
        fetch.mockImplementation(async () => {
            state.subscriptions[0].url = 'https://edited.example/sub';
            return new Response(node);
        });
        await generateCombinedNodeList(context, {}, 'ClashMeta', [source], '', {}, false);
        await Promise.all(pending);
        expect(commitObservation).toHaveBeenCalledTimes(1);
        expect(context.subscriptionRuntimeObservations.one).toMatchObject({
            status: 'rejected',
            reason: 'identity_conflict',
        });
        expect(state.subscriptions[0].nodeCount).toBeUndefined();
        expectNoLegacyWrite(storage);
    });
    it('strict subscription GET reads one snapshot without migrating profile IDs', async () => {
        const { state, storage } = fixture();
        state.profiles = [{ id: 'profile_legacy', enabled: true, subscriptions: ['one'] }];
        await handleMisubRequest({
            env: {},
            request: new Request('https://misub.invalid/sub/wrong'),
            waitUntil: vi.fn(),
        });
        expect(storage.readSubscriptionSnapshot).toHaveBeenCalledTimes(1);
        expect(state.profiles[0].id).toBe('profile_legacy');
        expect(storage.getAllSubscriptions).not.toHaveBeenCalled();
        expect(storage.getAllProfiles).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it.each(['unrecognized'])('schedule rejects %s before touching raw bindings', async (mode) => {
        const kv = { get: vi.fn(), put: vi.fn() };
        const db = { prepare: vi.fn(), batch: vi.fn() };
        await expect(
            performSubscriptionSync({
                MISUB_SUBSCRIPTION_PROTOCOL: mode,
                MISUB_SUBSCRIPTION_AUTHORITY: 'fixture',
                MISUB_DB: db,
                KV_STORAGE: kv,
                DB: db,
            })
        ).rejects.toMatchObject({
            code: 'invalid_protocol_mode',
        });
        expect(kv.get).not.toHaveBeenCalled();
        expect(db.prepare).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('strict Telegram preview-only legacy command routing', () => {
    function telegramFixture() {
        const value = fixture([
            {
                id: 'one',
                name: 'Zulu',
                url: 'https://source.example/sub',
                enabled: true,
                group: 'group',
                _writeGeneration: 'g1',
            },
            {
                id: 'duplicate',
                name: 'Alpha',
                url: 'https://source.example/sub',
                enabled: false,
                _writeGeneration: 'g2',
            },
            {
                id: 'manual',
                name: 'Manual',
                url: node,
                enabled: true,
                group: 'group',
                _writeGeneration: 'g3',
            },
        ]);
        value.state.profiles = [
            { id: 'profile-1', name: 'Profile', subscriptions: ['one'], manualNodes: ['manual'] },
        ];
        value.settings.telegram_push_config.user_bindings = { 1: 'profile-1' };
        Object.assign(value.storage, {
            readDomainSnapshot: vi.fn(async () =>
                structuredClone({ ...value.state, settings: value.settings })
            ),
            readTelegramPreview: vi.fn(async () => null),
            createTelegramPreview: vi.fn(async (preview) => preview),
            commitTelegramPreview: vi.fn(),
        });
        return value;
    }
    function webhook(update) {
        return new Request('https://misub.invalid/api/telegram/webhook', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Bot-Api-Secret-Token': 'synthetic-secret',
            },
            body: JSON.stringify({ update_id: 1, ...update }),
        });
    }
    it.each([
        '/delete 1',
        '/del 1',
        '/rm 1',
        '/enable all',
        '/on 1',
        '/disable 1',
        '/off 1',
        '/rename 1 renamed',
        '/grename old new',
        '/sort name',
        '/dup clean',
        '/dup remove',
        '/dedup clean',
        '/dedup remove',
        '/import data',
        '/bind 1',
        '/unbind',
        'https://source.example/sub',
        node,
    ])('previews or displays %s without collection writes', async (text) => {
        const { storage } = telegramFixture();
        fetch.mockImplementation(async () => new Response('{"ok":true}'));
        const response = await handleTelegramWebhook(
            webhook({ message: { from: { id: 1 }, chat: { id: 1 }, text } }),
            {}
        );
        const body = await response.json();
        expect(body).toMatchObject({ ok: true });
        expect(body.code).toBeUndefined();
        expect(fetch).toHaveBeenCalled();
        expect(storage.readDomainSnapshot).toHaveBeenCalledOnce();
        expect(storage.commitTelegramPreview).not.toHaveBeenCalled();
        for (const [preview] of storage.createTelegramPreview.mock.calls) {
            expect(preview.baseVersion).toEqual({ epoch: 'fixture-epoch', revision: 4 });
            expect(preview.actorId).toBe('1');
            expect(preview.chatId).toBe('1');
        }
        expectNoLegacyWrite(storage);
    });
    it.each([
        'do_delete_sub_0',
        'do_delete_node_0',
        'toggle_node_0',
        'toggle_sub_0',
        'link_sub_0_profile-1',
        'link_node_0_profile-1',
        'unlink_sub_0_profile-1',
        'unlink_node_0_profile-1',
        'cmd_dup_clean',
        'gmrm_node_group',
        'gmcl_sub_group',
        'gmrn_node_group',
        'cmd_enable_all',
        'cmd_disable_all',
        'confirm_delete_all',
        'do_delete_all',
        'bind_profile_profile-1',
        'unbind_profile',
    ])('previews or displays old callback %s without executing it', async (data) => {
        const { storage } = telegramFixture();
        fetch.mockImplementation(async () => new Response('{"ok":true}'));
        const response = await handleTelegramWebhook(
            webhook({
                callback_query: {
                    id: 'callback-fixture',
                    from: { id: 1 },
                    message: { chat: { id: 1 }, message_id: 3 },
                    data,
                },
            }),
            {}
        );
        const body = await response.json();
        expect(body).toMatchObject({ ok: true });
        expect(body.code).toBeUndefined();
        expect(storage.readDomainSnapshot).toHaveBeenCalledOnce();
        expect(storage.commitTelegramPreview).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('previews a synthetic file import after parsing without writing collections', async () => {
        const { storage } = telegramFixture();
        fetch.mockImplementation(async (url) => {
            if (url.includes('/getFile?'))
                return Response.json({ ok: true, result: { file_path: 'fixture.txt' } });
            if (url.includes('/file/bot')) return new Response('ss://new@fixture.invalid:443#New');
            return Response.json({ ok: true });
        });
        const response = await handleTelegramWebhook(
            webhook({
                message: {
                    from: { id: 1 },
                    chat: { id: 1 },
                    document: { file_id: 'synthetic-document' },
                },
            }),
            {}
        );
        expect(await response.json()).toMatchObject({ ok: true, preview: true });
        expect(storage.createTelegramPreview).toHaveBeenCalledOnce();
        expect(storage.commitTelegramPreview).not.toHaveBeenCalled();
        expectNoLegacyWrite(storage);
    });
    it('keeps read-only stats available', async () => {
        const { storage } = telegramFixture();
        fetch.mockImplementation(async () => new Response('{"ok":true}'));
        const response = await handleTelegramWebhook(
            webhook({ message: { from: { id: 1 }, chat: { id: 1 }, text: '/stats' } }),
            {}
        );
        expect(await response.json()).toEqual({ ok: true });
        expect(storage.readDomainSnapshot).toHaveBeenCalledTimes(1);
        expectNoLegacyWrite(storage);
    });
});
