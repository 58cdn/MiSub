import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KV_KEY_SETTINGS, KV_KEY_SUBS } from '../../functions/modules/config.js';
import {
    createTelegramPreviewScope,
    identifyTelegramPreview,
    buildTelegramPreview,
    markTelegramPreviewFailed,
    queueTelegramPreviewMessage,
    formatTelegramPreview,
} from '../../functions/services/telegram-preview-service.js';
import { handleTelegramWebhook } from '../../functions/modules/handlers/telegram-webhook-handler.js';

const mocks = vi.hoisted(() => ({ adapter: null, clear: vi.fn(), failProfiles: false }));
vi.mock('../../functions/storage-adapter.js', () => ({
    StorageFactory: { getStorageType: async () => 'd1', createAdapter: () => mocks.adapter },
}));
vi.mock('../../functions/services/node-cache-service.js', () => ({
    clearAllNodeCaches: (...args) => mocks.clear(...args),
}));
vi.mock('../../functions/services/telegram-preview-service.js', async (load) => {
    const actual = await load();
    return {
        ...actual,
        createTelegramPreviewScope: (...args) => {
            const scope = actual.createTelegramPreviewScope(...args);
            if (mocks.failProfiles)
                scope.adapter = {
                    ...scope.adapter,
                    putAllProfiles: async () => {
                        throw new Error('fixture profile write failure');
                    },
                };
            return scope;
        },
    };
});

const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
    return {
        version: { epoch: 'fixture_epoch', revision: 3 },
        subscriptions: [
            {
                id: 'node-a',
                name: 'Bravo',
                url: 'ss://fixture@host.invalid:443#Bravo',
                enabled: true,
                group: 'Group',
                _writeGeneration: 'g-a',
            },
            {
                id: 'node-b',
                name: 'Alpha',
                url: 'ss://other@host.invalid:443#Alpha',
                enabled: false,
                _writeGeneration: 'g-b',
            },
        ],
        profiles: [
            { id: 'profile-a', name: 'Profile A', manualNodes: ['node-a'], subscriptions: [] },
        ],
        settings: {
            telegram_push_config: {
                enabled: true,
                bot_token: 'fixture-bot-token',
                webhook_secret: 'fixture-webhook-secret',
                allowed_user_ids: ['1', '2'],
                user_bindings: { 1: 'profile-a' },
                auto_bind: false,
            },
        },
    };
}
const message = (text, update_id = 10, actorId = 1, chatId = 100) => ({
    update_id,
    message: { text, message_id: update_id, from: { id: actorId }, chat: { id: chatId } },
});
const callback = (data, update_id = 20, actorId = 1, chatId = 100) => ({
    update_id,
    callback_query: {
        id: `callback-${update_id}`,
        data,
        from: { id: actorId },
        message: { message_id: 1, chat: { id: chatId } },
    },
});
async function invoke(update) {
    const request = new Request('https://fixture.invalid/api/telegram/webhook', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': 'fixture-webhook-secret',
        },
        body: JSON.stringify(update),
    });
    return handleTelegramWebhook(request, {});
}
function bodies() {
    return fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
}

describe('Telegram request-scoped preview buffer', () => {
    it('isolates each request and copies reads until explicitly written', async () => {
        const initial = fixture();
        const one = createTelegramPreviewScope({}, initial);
        const two = createTelegramPreviewScope({}, initial);
        const rows = await one.adapter.getAllSubscriptions();
        rows[0].name = 'Edited';
        expect((await one.adapter.getAllSubscriptions())[0].name).toBe('Bravo');
        await one.adapter.put(KV_KEY_SUBS, rows);
        expect((await one.adapter.getAllSubscriptions())[0].name).toBe('Edited');
        expect((await two.adapter.getAllSubscriptions())[0].name).toBe('Bravo');
        expect(initial.subscriptions[0].name).toBe('Bravo');
    });
    it('denies unknown storage keys and suppresses any partially prepared preview', async () => {
        const scope = createTelegramPreviewScope({}, fixture());
        await expect(scope.adapter.put('unknown', {})).rejects.toThrow();
        expect(() => buildTelegramPreview(scope, { actorId: '1' })).toThrow(
            'telegram_preview_failed'
        );
    });
    it('requires stable Telegram update, actor, and chat identity', async () => {
        const first = await identifyTelegramPreview(message('/delete 1'));
        expect(first.id).toMatch(/^[a-f0-9]{32}$/);
        expect(await identifyTelegramPreview(message('/delete 1'))).toEqual(first);
        expect((await identifyTelegramPreview(message('/delete 2'))).sourceDigest).not.toBe(
            first.sourceDigest
        );
        await expect(
            identifyTelegramPreview({ message: message('/delete 1').message })
        ).rejects.toThrow();
    });
    it('permits only the current actor binding and never stores config secrets', async () => {
        const scope = createTelegramPreviewScope({}, fixture());
        const settings = await scope.adapter.get(KV_KEY_SETTINGS);
        settings.telegram_push_config.user_bindings[1] = '';
        settings.telegram_push_config.auto_bind = true;
        await scope.adapter.put(KV_KEY_SETTINGS, settings);
        const result = buildTelegramPreview(scope, { actorId: '1' });
        expect(result.settingsPatch).toEqual({
            telegram_push_config: { user_bindings: { 1: '' } },
        });
        expect(JSON.stringify(result)).not.toContain('token');
        settings.telegram_push_config.user_bindings[2] = 'profile-a';
        await scope.adapter.put(KV_KEY_SETTINGS, settings);
        expect(() => buildTelegramPreview(scope, { actorId: '1' })).toThrow(
            'telegram_settings_change_denied'
        );
    });
    it('fails closed for explicit handler failures and queue overflow', () => {
        const scope = createTelegramPreviewScope({}, fixture());
        markTelegramPreviewFailed(scope.env);
        expect(() => buildTelegramPreview(scope, { actorId: '1' })).toThrow();
        const second = createTelegramPreviewScope({}, fixture());
        for (let i = 0; i < 100; i++)
            queueTelegramPreviewMessage(second.env, 'send', [100, 'fixture']);
        expect(() => queueTelegramPreviewMessage(second.env, 'send', [100, 'overflow'])).toThrow();
        expect(second.failed).toBe(true);
    });
    it('shows every reorder target across bounded messages without truncating the selection', () => {
        const snapshot = fixture();
        const ids = Array.from({ length: 500 }, (_, i) => `stable-target-${i}`);
        const chunks = formatTelegramPreview(
            {
                baseVersion: snapshot.version,
                operations: [{ type: 'reorder', collection: 'subscriptions', ids }],
                expiresAt: 2000000000000,
            },
            snapshot
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.length <= 3501)).toBe(true);
        for (const id of ids) expect(chunks.join('\n')).toContain(id);
        expect(chunks.join('\n')).toContain('2033-05-18');
    });
});

describe('Telegram strict preview routing', () => {
    let state;
    let stored;
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.failProfiles = false;
        state = fixture();
        stored = new Map();
        mocks.clear.mockResolvedValue({ cleared: 1 });
        mocks.adapter = {
            subscriptionProtocol: 'd1-v1',
            get: vi.fn(async () => clone(state.settings)),
            readDomainSnapshot: vi.fn(async () => clone(state)),
            readTelegramPreview: vi.fn(async ({ id }) => clone(stored.get(id) ?? null)),
            createTelegramPreview: vi.fn(async (preview) => {
                stored.set(preview.id, clone(preview));
                return clone(preview);
            }),
            commitTelegramPreview: vi.fn(async () => ({
                receipt: { version: { epoch: 'fixture_epoch', revision: 4 } },
                replayed: false,
            })),
            put: vi.fn(() => {
                throw new Error('real storage mutation');
            }),
            putAllSubscriptions: vi.fn(() => {
                throw new Error('real collection mutation');
            }),
            putAllProfiles: vi.fn(() => {
                throw new Error('real profile mutation');
            }),
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each(['/list', '/stats', '/menu', '/bind', '/info 1', '/copy 1', '/dup'])(
        'keeps read-only %s available without a preview write',
        async (command) => {
            await invoke(message(command));
            expect(fetch).toHaveBeenCalled();
            expect(mocks.adapter.createTelegramPreview).not.toHaveBeenCalled();
            expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
            for (const body of bodies()) {
                expect(body).not.toHaveProperty('requestCache');
                expect(JSON.stringify(body)).not.toContain('fixture-bot-token');
                expect(JSON.stringify(body)).not.toContain('fixture-webhook-secret');
            }
        }
    );
    it.each(['cmd_menu', 'cmd_stats', 'cmd_list_node', 'cmd_bind', 'node_action_0'])(
        'restores read-only callback %s',
        async (data) => {
            await invoke(callback(data));
            expect(fetch).toHaveBeenCalled();
            expect(mocks.adapter.createTelegramPreview).not.toHaveBeenCalled();
            expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
        }
    );
    it.each([
        ['/delete 1', 'remove'],
        ['/disable 1', 'update'],
        ['/rename 1 Renamed', 'update'],
        ['/sort name', 'reorder'],
    ])('previews %s against stable targets with no collection writes', async (command, type) => {
        const before = clone(state);
        expect(await (await invoke(message(command))).json()).toMatchObject({ preview: true });
        const preview = mocks.adapter.createTelegramPreview.mock.calls[0][0];
        expect(preview.baseVersion).toEqual(state.version);
        expect(
            preview.operations.some((op) => op.type === type && op.collection === 'subscriptions')
        ).toBe(true);
        expect(state).toEqual(before);
        expect(mocks.adapter.putAllSubscriptions).not.toHaveBeenCalled();
        expect(mocks.adapter.putAllProfiles).not.toHaveBeenCalled();
        expect(mocks.adapter.put).not.toHaveBeenCalled();
        expect(mocks.clear).not.toHaveBeenCalled();
        expect(bodies().some((body) => body.text?.includes('待确认'))).toBe(true);
        expect(bodies().at(-1).reply_markup.inline_keyboard[0][0].callback_data).toBe(
            `tg_confirm_${preview.id}`
        );
    });
    it.each([
        'toggle_node_0',
        'do_delete_node_0',
        'unlink_node_0',
        'bind_profile_profile-a',
        'unbind_profile',
    ])('makes a fresh preview from legacy action %s', async (data) => {
        if (data.startsWith('bind_')) state.settings.telegram_push_config.user_bindings[1] = '';
        await invoke(callback(data));
        expect(mocks.adapter.createTelegramPreview).toHaveBeenCalledOnce();
        expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
        expect(bodies().some((body) => body.text?.includes('已删除'))).toBe(false);
    });
    it('buffers imported nodes plus profile linkage as one preview and preserves trusted metadata', async () => {
        await invoke(message('ss://new@fixture.invalid:443#New'));
        const preview = mocks.adapter.createTelegramPreview.mock.calls[0][0];
        const create = preview.operations.find((op) => op.type === 'create');
        expect(create.item.name).toBe('New');
        expect(create.item).not.toHaveProperty('telegram_user_id');
        expect(preview.createMetadata[create.item.id]).toEqual({
            telegram_user_id: 1,
            created_at: expect.any(String),
        });
        expect(
            preview.operations.find((op) => op.collection === 'profiles').fields.manualNodes
        ).toContain(create.item.id);
        expect(mocks.clear).not.toHaveBeenCalled();
        expect(bodies().some((body) => body.text?.includes('添加成功'))).toBe(false);
    });
    it('parses a mocked Telegram file into the same preview without sending progress or success early', async () => {
        const deliveries = [];
        fetch.mockImplementation(async (url, options) => {
            if (url.includes('/getFile?'))
                return Response.json({ ok: true, result: { file_path: 'fixture.txt' } });
            if (url.includes('/file/bot'))
                return new Response('ss://file@fixture.invalid:443#File');
            deliveries.push({
                created: mocks.adapter.createTelegramPreview.mock.calls.length,
                body: JSON.parse(options.body),
            });
            return Response.json({ ok: true });
        });
        const update = message(undefined);
        update.message.document = {
            file_id: 'fixture-file',
            file_size: 50,
            file_name: 'fixture.txt',
        };
        await invoke(update);
        const preview = mocks.adapter.createTelegramPreview.mock.calls[0][0];
        expect(preview.operations.find((op) => op.type === 'create').item.name).toBe('File');
        expect(mocks.adapter.put).not.toHaveBeenCalled();
        expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
        expect(mocks.clear).not.toHaveBeenCalled();
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0].created).toBe(1);
        expect(deliveries[0].body.text).toContain('待确认');
    });
    it('preserves Base64 import fallback parsing in preview mode', async () => {
        await invoke(message(`/import ${btoa('ss://encoded@fixture.invalid:443#Encoded')}`));
        expect(mocks.adapter.createTelegramPreview).toHaveBeenCalledOnce();
        const preview = mocks.adapter.createTelegramPreview.mock.calls[0][0];
        expect(preview.operations.find((op) => op.type === 'create').item.name).toBe('Encoded');
    });
    it('reuses a repeated update preview without parsing or generating another import', async () => {
        const update = message('ss://new@fixture.invalid:443#New');
        await invoke(update);
        const first = clone(mocks.adapter.createTelegramPreview.mock.calls[0][0]);
        await invoke(update);
        expect(mocks.adapter.createTelegramPreview).toHaveBeenCalledOnce();
        expect(stored.get(first.id)).toEqual(first);
        await invoke(message('/delete all'));
        expect(mocks.adapter.createTelegramPreview).toHaveBeenCalledOnce();
        expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
    });
    it('submits only token, actor and chat on confirmation, including duplicate confirmation', async () => {
        await invoke(message('/delete 1'));
        const preview = mocks.adapter.createTelegramPreview.mock.calls[0][0];
        await invoke(callback(`tg_confirm_${preview.id}`));
        expect(mocks.adapter.commitTelegramPreview).toHaveBeenCalledWith({
            id: preview.id,
            actorId: '1',
            chatId: '100',
        });
        expect(mocks.clear).toHaveBeenCalledOnce();
        mocks.adapter.commitTelegramPreview.mockResolvedValueOnce({
            receipt: { version: { epoch: 'fixture_epoch', revision: 4 } },
            replayed: true,
        });
        await invoke(message(`/confirm ${preview.id}`, 30));
        expect(mocks.adapter.commitTelegramPreview).toHaveBeenCalledTimes(2);
        expect(mocks.clear).toHaveBeenCalledOnce();
        expect(mocks.adapter.createTelegramPreview).toHaveBeenCalledOnce();
    });
    it.each([
        'revision_conflict',
        'preview_expired',
        'preview_actor_mismatch',
        'storage_unavailable',
    ])('does not rerun or fall back when confirmation rejects %s', async (code) => {
        mocks.adapter.commitTelegramPreview.mockRejectedValue(
            Object.assign(new Error(code), { code })
        );
        await invoke(callback(`tg_confirm_${'a'.repeat(32)}`));
        expect(mocks.adapter.commitTelegramPreview).toHaveBeenCalledOnce();
        expect(mocks.adapter.createTelegramPreview).not.toHaveBeenCalled();
        expect(mocks.adapter.put).not.toHaveBeenCalled();
        expect(mocks.clear).not.toHaveBeenCalled();
        expect(bodies().some((body) => body.text?.includes('已提交'))).toBe(false);
    });
    it('forwards the actual actor and chat to confirmation and rechecks current authorization', async () => {
        const confirm = callback(`tg_confirm_${'a'.repeat(32)}`, 20, 2, 200);
        await invoke(confirm);
        expect(mocks.adapter.commitTelegramPreview).toHaveBeenCalledWith({
            id: 'a'.repeat(32),
            actorId: '2',
            chatId: '200',
        });
        mocks.adapter.commitTelegramPreview.mockClear();
        mocks.adapter.readDomainSnapshot.mockImplementationOnce(async () => {
            const next = clone(state);
            next.settings.telegram_push_config.allowed_user_ids = ['1'];
            return next;
        });
        expect((await invoke(confirm)).status).toBe(403);
        expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
    });
    it('discards a partial collection edit when the legacy cleanup catch handles a failure', async () => {
        mocks.failProfiles = true;
        await invoke(message('/delete 1'));
        expect(mocks.adapter.createTelegramPreview).not.toHaveBeenCalled();
        expect(mocks.adapter.commitTelegramPreview).not.toHaveBeenCalled();
        expect(state.subscriptions).toHaveLength(2);
        expect(bodies().some((body) => body.text?.includes('已删除'))).toBe(false);
    });
    it('keeps legacy command writes operational when the protocol is disabled', async () => {
        mocks.adapter.subscriptionProtocol = 'legacy';
        mocks.adapter.getAllSubscriptions = vi.fn(async () => clone(state.subscriptions));
        mocks.adapter.putAllSubscriptions.mockResolvedValue(true);
        await invoke(message('/disable 1'));
        expect(mocks.adapter.putAllSubscriptions).toHaveBeenCalledOnce();
        expect(mocks.adapter.readDomainSnapshot).not.toHaveBeenCalled();
    });
});
