// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProtocolFixture } from '../fixtures/subscription-protocol-db.js';
import { StorageFactory } from '../../functions/storage-adapter.js';
import { handleTelegramWebhook } from '../../functions/modules/handlers/telegram-webhook-handler.js';

vi.mock('../../functions/services/node-cache-service.js', () => ({
    clearAllNodeCaches: vi.fn(async () => ({ cleared: 0 })),
}));
let fixture;
let storage;
let sequence;
const node = 'ss://fixture@fixture.invalid:443#Fixture';
const clone = (value) => JSON.parse(JSON.stringify(value));
const message = (text, actor = 1, chat = 100) => ({
    update_id: ++sequence,
    message: { from: { id: actor }, chat: { id: chat }, text },
});
const confirm = (id, actor = 1, chat = 100) => ({
    update_id: ++sequence,
    callback_query: {
        id: `callback-${sequence}`,
        from: { id: actor },
        message: { chat: { id: chat }, message_id: 1 },
        data: `tg_confirm_${id}`,
    },
});

async function invoke(update) {
    const response = await handleTelegramWebhook(
        new Request('https://fixture.invalid/api/telegram/webhook', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Bot-Api-Secret-Token': 'fixture-webhook-secret',
            },
            body: JSON.stringify(update),
        }),
        fixture.env
    );
    return { status: response.status, body: await response.json() };
}
async function preview(text) {
    expect((await invoke(message(text))).body.preview).toBe(true);
    const row = fixture.sql
        .prepare('SELECT * FROM subscription_protocol_previews ORDER BY rowid DESC LIMIT 1')
        .get();
    return { ...JSON.parse(row.payload), expiresAt: row.expires_at };
}
beforeEach(async () => {
    sequence = 0;
    fixture = await createProtocolFixture({
        subscriptions: [
            { id: 'node-a', name: 'Node A', url: node, enabled: true },
            { id: 'node-b', name: 'Node B', url: `${node}B`, enabled: true },
        ],
        profiles: [
            {
                id: 'profile-a',
                name: 'Profile A',
                subscriptions: [],
                manualNodes: ['node-a', 'node-b'],
            },
        ],
        settings: {
            telegram_push_config: {
                enabled: true,
                bot_token: 'fixture-bot-token',
                webhook_secret: 'fixture-webhook-secret',
                allowed_user_ids: ['1', '2'],
                user_bindings: { 1: 'profile-a' },
            },
        },
    });
    storage = StorageFactory.createAdapter(fixture.env, 'd1');
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ ok: true }))
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
    fixture?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Telegram handler preview and confirmation with real SQLite', () => {
    it('deletes the previewed stable target plus references once, and replays the same receipt', async () => {
        const before = await storage.readDomainSnapshot();
        const value = await preview('/delete 1');
        expect(await storage.readDomainSnapshot()).toEqual(before);
        expect((await invoke(confirm(value.id))).body).toMatchObject({
            confirmed: true,
            replayed: false,
        });
        const after = await storage.readDomainSnapshot();
        expect(after.subscriptions.map(({ id }) => id)).toEqual(['node-b']);
        expect(after.profiles[0].manualNodes).toEqual(['node-b']);
        expect(after.version.revision).toBe(before.version.revision + 1);
        expect((await invoke(confirm(value.id))).body).toMatchObject({
            confirmed: true,
            replayed: true,
        });
        expect(await storage.readDomainSnapshot()).toEqual(after);
        expect(
            fixture.sql.prepare('SELECT count(*) total FROM subscription_protocol_receipts').get()
                .total
        ).toBe(1);
    });
    it('imports a node and profile reference atomically with trusted creation metadata', async () => {
        const value = await preview('ss://new@fixture.invalid:443#New');
        expect((await storage.readSubscriptionSnapshot()).subscriptions).toHaveLength(2);
        expect((await invoke(confirm(value.id))).body.confirmed).toBe(true);
        const after = await storage.readSubscriptionSnapshot();
        const added = after.subscriptions.find((item) => item.name === 'New');
        expect(added).toMatchObject({
            telegram_user_id: 1,
            created_at: expect.any(String),
            _writeGeneration: expect.any(String),
        });
        expect(after.profiles[0].manualNodes).toContain(added.id);
        expect(fetch.mock.calls.every(([url]) => url.startsWith('https://api.telegram.org/'))).toBe(
            true
        );
    });
    it('commits unbind through the settings domain without persisting full settings in a preview', async () => {
        const before = await storage.readDomainSnapshot();
        const value = await preview('/unbind');
        expect(value.settingsPatch).toEqual({ telegram_push_config: { user_bindings: { 1: '' } } });
        const raw = fixture.sql
            .prepare('SELECT payload FROM subscription_protocol_previews WHERE id=?')
            .get(value.id).payload;
        expect(raw).not.toContain('bot_token');
        expect(raw).not.toContain('fixture-webhook-secret');
        expect((await invoke(confirm(value.id))).body.confirmed).toBe(true);
        const after = await storage.readDomainSnapshot();
        expect(after.settings.telegram_push_config.user_bindings[1]).toBe('');
        expect(after.settings.telegram_push_config.bot_token).toBe('fixture-bot-token');
        expect(after.version.revision).toBe(before.version.revision + 1);
    });
    it('rejects confirmation after another writer reorders targets instead of deleting the new first row', async () => {
        const value = await preview('/delete 1');
        await storage.commitSubscriptionOperations({
            operationId: 'other-writer',
            baseVersion: value.baseVersion,
            operations: [
                { type: 'reorder', collection: 'subscriptions', ids: ['node-b', 'node-a'] },
            ],
        });
        const before = await storage.readDomainSnapshot();
        expect((await invoke(confirm(value.id))).body.confirmed).not.toBe(true);
        expect(await storage.readDomainSnapshot()).toEqual(before);
        expect(before.subscriptions.map(({ id }) => id)).toEqual(['node-b', 'node-a']);
    });
    it('rejects a token in another actor or chat without touching the domain', async () => {
        const value = await preview('/delete 1');
        const before = await storage.readDomainSnapshot();
        expect((await invoke(confirm(value.id, 2))).body.confirmed).not.toBe(true);
        expect((await invoke(confirm(value.id, 1, 200))).body.confirmed).not.toBe(true);
        expect(await storage.readDomainSnapshot()).toEqual(before);
        expect((await invoke(confirm(value.id))).body.confirmed).toBe(true);
    });
    it('rejects first confirmation after expiry but allows an already committed receipt replay', async () => {
        const first = await preview('/disable 1');
        const now = vi.spyOn(Date, 'now').mockReturnValue(first.expiresAt + 1);
        expect((await invoke(confirm(first.id))).body.confirmed).not.toBe(true);
        expect((await storage.readSubscriptionSnapshot()).subscriptions[0].enabled).toBe(true);
        now.mockRestore();
        const second = await preview('/disable 1');
        expect((await invoke(confirm(second.id))).body.confirmed).toBe(true);
        const after = await storage.readDomainSnapshot();
        vi.spyOn(Date, 'now').mockReturnValue(second.expiresAt + 1);
        expect((await invoke(confirm(second.id))).body).toMatchObject({
            confirmed: true,
            replayed: true,
        });
        expect(await storage.readDomainSnapshot()).toEqual(after);
    });
    it('rolls back a failed confirmation batch and retries the stored intent with the same token', async () => {
        const value = await preview('/delete 1');
        const before = clone(await storage.readDomainSnapshot());
        fixture.state.failAt = 5;
        expect((await invoke(confirm(value.id))).body.confirmed).not.toBe(true);
        expect(await storage.readDomainSnapshot()).toEqual(before);
        expect(
            fixture.sql.prepare('SELECT count(*) total FROM subscription_protocol_receipts').get()
                .total
        ).toBe(0);
        fixture.state.failAt = -1;
        expect((await invoke(confirm(value.id))).body.confirmed).toBe(true);
        expect(
            (await storage.readSubscriptionSnapshot()).subscriptions.map(({ id }) => id)
        ).toEqual(['node-b']);
    });
    it('repeated update delivery reuses exactly one stored preview', async () => {
        const update = message('ss://new@fixture.invalid:443#New');
        expect((await invoke(update)).body.preview).toBe(true);
        const first = fixture.sql
            .prepare('SELECT payload FROM subscription_protocol_previews')
            .get().payload;
        expect((await invoke(update)).body.preview).toBe(true);
        expect(
            fixture.sql.prepare('SELECT payload FROM subscription_protocol_previews').all()
        ).toEqual([{ payload: first }]);
    });
});
