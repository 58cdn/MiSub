import { KV_KEY_SUBS, KV_KEY_PROFILES, KV_KEY_SETTINGS } from '../modules/config.js';
import { buildSubscriptionEditOperations } from '../../src/shared/subscription-edit-operations.js';
import { canonicalJson, hashValue } from './subscription-protocol/operations.js';

const requestScope = Symbol('telegramPreviewScope');
const clone = (value) => JSON.parse(JSON.stringify(value));
const collections = { [KV_KEY_SUBS]: 'subscriptions', [KV_KEY_PROFILES]: 'profiles' };
const equal = (left, right) => canonicalJson(left) === canonicalJson(right);

export function getTelegramPreviewScope(env) {
    return env?.[requestScope] ?? null;
}

export function markTelegramPreviewFailed(env) {
    const scope = getTelegramPreviewScope(env);
    if (scope) scope.failed = true;
}

export async function identifyTelegramPreview(update) {
    const message = update.callback_query?.message ?? update.message;
    const actor = update.callback_query?.from ?? update.message?.from;
    if (
        !Number.isSafeInteger(update.update_id) ||
        !Number.isSafeInteger(actor?.id) ||
        !Number.isSafeInteger(message?.chat?.id)
    ) {
        throw new Error('telegram_update_identity_required');
    }
    const actorId = String(actor.id);
    const chatId = String(message.chat.id);
    const id = (await hashValue({ updateId: update.update_id, actorId, chatId })).slice(0, 32);
    return { id, actorId, chatId, sourceDigest: await hashValue(update) };
}

export function createTelegramPreviewScope(env, snapshot) {
    const baseline = clone(snapshot);
    const state = clone(snapshot);
    const scope = { baseline, state, failed: false, messages: [], clearCaches: false };
    const deny = () => {
        scope.failed = true;
        throw new Error('telegram_preview_storage_access_denied');
    };
    const read = (key) => {
        if (Object.hasOwn(collections, key)) return clone(state[collections[key]]);
        if (key === KV_KEY_SETTINGS) return clone(state.settings);
        return deny();
    };
    const write = (key, value) => {
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : clone(value);
            if (Object.hasOwn(collections, key) && Array.isArray(parsed)) {
                state[collections[key]] = parsed;
            } else if (
                key === KV_KEY_SETTINGS &&
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            ) {
                state.settings = parsed;
            } else return deny();
            return true;
        } catch (error) {
            scope.failed = true;
            throw error;
        }
    };
    scope.adapter = Object.freeze({
        get: async (key) => read(key),
        put: async (key, value) => write(key, value),
        getAllSubscriptions: async () => read(KV_KEY_SUBS),
        getAllProfiles: async () => read(KV_KEY_PROFILES),
        putAllSubscriptions: async (value) => write(KV_KEY_SUBS, value),
        putAllProfiles: async (value) => write(KV_KEY_PROFILES, value),
    });
    scope.env = Object.assign(Object.create(env), { [requestScope]: scope });
    return scope;
}

export function queueTelegramPreviewMessage(env, method, args) {
    const scope = getTelegramPreviewScope(env);
    if (!scope) return false;
    if (scope.messages.length >= 100) {
        scope.failed = true;
        throw new Error('telegram_preview_message_limit');
    }
    scope.messages.push({ method, args: clone(args) });
    return true;
}

export function deferTelegramCacheClear(env) {
    const scope = getTelegramPreviewScope(env);
    if (!scope) return false;
    scope.clearCaches = true;
    return true;
}

export function buildTelegramPreview(scope, identity) {
    if (scope.failed) throw new Error('telegram_preview_failed');
    const operations = buildSubscriptionEditOperations(scope.baseline, scope.state);
    const originalSettings = clone(scope.baseline.settings);
    const editedSettings = clone(scope.state.settings);
    const oldConfig = originalSettings.telegram_push_config ?? {};
    const newConfig = editedSettings.telegram_push_config ?? {};
    const actorId = identity.actorId;
    const oldBinding = oldConfig.user_bindings?.[actorId];
    const newBinding = newConfig.user_bindings?.[actorId];
    let settingsPatch;
    if (oldBinding !== newBinding) {
        if (typeof newBinding !== 'string') throw new Error('telegram_binding_invalid');
        settingsPatch = { telegram_push_config: { user_bindings: { [actorId]: newBinding } } };
    }
    // Global auto_bind controls default-profile behavior; this patch changes only the actor binding.
    if (oldConfig.auto_bind === undefined) delete newConfig.auto_bind;
    else newConfig.auto_bind = oldConfig.auto_bind;
    if (newConfig.user_bindings) {
        if (oldBinding === undefined) delete newConfig.user_bindings[actorId];
        else newConfig.user_bindings[actorId] = oldBinding;
        if (!oldConfig.user_bindings && Object.keys(newConfig.user_bindings).length === 0)
            delete newConfig.user_bindings;
    }
    if (!equal(originalSettings, editedSettings))
        throw new Error('telegram_settings_change_denied');

    const createMetadata = {};
    for (const operation of operations) {
        if (operation.type !== 'create' || operation.collection !== 'subscriptions') continue;
        const item = scope.state.subscriptions.find(({ id }) => id === operation.item.id);
        createMetadata[item.id] = {
            telegram_user_id: Number(actorId),
            created_at: item.created_at,
        };
    }
    return {
        ...identity,
        baseVersion: clone(scope.baseline.version),
        operations,
        ...(settingsPatch ? { settingsPatch } : {}),
        ...(Object.keys(createMetadata).length ? { createMetadata } : {}),
    };
}

const escape = (text) =>
    String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const label = (item) => `${escape(item?.name || '未命名')} [${escape(item?.id || '')}]`;
const safeValue = (field, value) => {
    if (['name', 'group', 'enabled', 'isPublic'].includes(field))
        return escape(JSON.stringify(value));
    return '更新配置值';
};

export function formatTelegramPreview(preview, snapshot) {
    const lines = [
        '🔎 <b>待确认的操作</b>',
        '以下是当前数据中的目标。旧序号或按钮只生成此预览；尚未修改数据。',
        `版本：${escape(preview.baseVersion.epoch)} / ${preview.baseVersion.revision}`,
    ];
    for (const operation of preview.operations) {
        const rows = snapshot[operation.collection];
        const find = (id) => rows.find((item) => item.id === id) ?? { id };
        if (operation.type === 'create') lines.push(`新增：${label(operation.item)}`);
        else if (operation.type === 'remove')
            for (const id of operation.ids) lines.push(`删除：${label(find(id))}`);
        else if (operation.type === 'update') {
            lines.push(`修改：${label(find(operation.id))}`);
            for (const [field, value] of Object.entries(operation.fields)) {
                if (['subscriptions', 'manualNodes'].includes(field) && Array.isArray(value)) {
                    lines.push(`  ${escape(field)} 关联目标（${value.length} 项）：`);
                    value.forEach((id) => lines.push(`  • ${escape(id)}`));
                } else lines.push(`  ${escape(field)} → ${safeValue(field, value)}`);
            }
        } else if (operation.type === 'reorder') {
            lines.push(`排序 ${operation.collection}（目标顺序）：`);
            operation.ids.forEach((id, index) => lines.push(`${index + 1}. ${escape(id)}`));
        }
    }
    if (preview.settingsPatch) {
        const id = preview.settingsPatch.telegram_push_config.user_bindings[preview.actorId];
        lines.push(
            id
                ? `绑定：${label(snapshot.profiles.find((item) => item.id === id) ?? { id })}`
                : '解除当前用户的订阅组绑定'
        );
    }
    lines.push(
        preview.expiresAt
            ? `首次确认截止：${new Date(preview.expiresAt).toISOString()}。已提交的操作可重复查询确认结果。`
            : '请核对目标后在 10 分钟内确认。'
    );
    if (!equal(preview.baseVersion, snapshot.version))
        lines.push('数据版本已变更。尚未提交的操作需重新生成预览；已提交操作可重试确认。');
    const chunks = [];
    let chunk = '';
    for (const line of lines) {
        if (line.length > 3500) throw new Error('telegram_preview_display_limit');
        if (chunk.length + line.length > 3500) {
            chunks.push(chunk);
            chunk = '';
        }
        chunk += `${line}\n`;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length > 100) throw new Error('telegram_preview_display_limit');
    return chunks;
}
