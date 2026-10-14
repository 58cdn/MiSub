import { StorageFactory } from '../storage-adapter.js';
import {
    isAtomicSubscriptionStorage,
    isAtomicSubscriptionRequested,
    requireMutationMetadata,
    protocolError,
    getProtocolError,
} from '../services/subscription-protocol/index.js';
import {
    createJsonResponse,
    createErrorResponse,
    JSON_BODY_LIMITS,
    readJsonWithLimit,
} from './utils.js';

export const KV_KEY_RULE_TEMPLATES = 'misub_rule_templates_v1';
const MAX_TEMPLATE_COUNT = 50;
const MAX_TEMPLATE_CONTENT_LENGTH = 128 * 1024;

function nowIso() {
    return new Date().toISOString();
}

function sanitizeId(value = '') {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function createId() {
    const random = Math.random().toString(36).slice(2, 10);
    return `rule-template-${Date.now().toString(36)}-${random}`;
}

function hasIniShape(content) {
    return /\[(custom|proxy\s*group|rule|ruleset|proxy)\]/i.test(content);
}

export function normalizeCustomRuleTemplates(input = []) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const normalized = [];

    for (const item of input.slice(0, MAX_TEMPLATE_COUNT)) {
        if (!item || typeof item !== 'object') continue;

        const content = typeof item.content === 'string' ? item.content.trim() : '';
        if (!content || content.length > MAX_TEMPLATE_CONTENT_LENGTH || !hasIniShape(content))
            continue;

        let id = sanitizeId(item.id) || createId();
        while (seen.has(id)) {
            id = `${id}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 80);
        }
        seen.add(id);

        const name =
            String(item.name || '')
                .trim()
                .slice(0, 80) || '未命名规则模板';
        const createdAt =
            item.createdAt && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : nowIso();

        normalized.push({
            id,
            name,
            description: String(item.description || '')
                .trim()
                .slice(0, 300),
            type: 'ini',
            content,
            enabled: item.enabled !== false,
            createdAt,
            updatedAt: nowIso(),
        });
    }

    return normalized;
}

export function validateStrictRuleTemplates(input) {
    if (!Array.isArray(input) || input.length > MAX_TEMPLATE_COUNT)
        throw protocolError('invalid_data');
    const ids = new Set();
    for (const item of input) {
        if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof item.id !== 'string' ||
            !item.id ||
            sanitizeId(item.id) !== item.id ||
            ids.has(item.id) ||
            typeof item.name !== 'string' ||
            !item.name.trim() ||
            item.name.length > 80 ||
            typeof item.content !== 'string' ||
            !item.content.trim() ||
            item.content.length > MAX_TEMPLATE_CONTENT_LENGTH ||
            !hasIniShape(item.content) ||
            (item.type !== undefined && item.type !== 'ini') ||
            (item.enabled !== undefined && typeof item.enabled !== 'boolean') ||
            (item.description !== undefined &&
                (typeof item.description !== 'string' || item.description.length > 300)) ||
            ['createdAt', 'updatedAt'].some(
                (key) =>
                    item[key] !== undefined &&
                    (typeof item[key] !== 'string' || Number.isNaN(Date.parse(item[key])))
            )
        )
            throw protocolError('invalid_data');
        ids.add(item.id);
    }
    return input;
}

async function getStorageAdapter(env) {
    if (env?.__TEST_STORAGE_ADAPTER) return env.__TEST_STORAGE_ADAPTER;
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

export async function listRuleTemplates(storageAdapter) {
    if (isAtomicSubscriptionStorage(storageAdapter))
        return (await storageAdapter.readDomainSnapshot()).ruleTemplates;
    const raw = await storageAdapter.get(KV_KEY_RULE_TEMPLATES);
    return normalizeCustomRuleTemplates(Array.isArray(raw) ? raw : []);
}

export async function resolveRuleTemplateSource(storageAdapter, templateSource) {
    if (!templateSource || templateSource.kind !== 'custom') return null;
    const templateId = sanitizeId(templateSource.value);
    if (!templateId) return null;

    const templates = await listRuleTemplates(storageAdapter);
    const template = templates.find((item) => item.enabled !== false && item.id === templateId);
    if (!template) return null;

    return {
        ...template,
        content: template.content,
        format: template.type || 'ini',
    };
}

export async function handleRuleTemplatesRequest(request, env) {
    try {
        const storageAdapter = await getStorageAdapter(env);

        if (request.method === 'GET') {
            if (isAtomicSubscriptionStorage(storageAdapter)) {
                const snapshot = await storageAdapter.readDomainSnapshot();
                return createJsonResponse({
                    success: true,
                    data: snapshot.ruleTemplates,
                    version: snapshot.version,
                    subscriptionProtocol: storageAdapter.subscriptionProtocol,
                });
            }
            const templates = await listRuleTemplates(storageAdapter);
            return createJsonResponse({ success: true, data: templates });
        }

        if (request.method === 'POST') {
            let body;
            try {
                body = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
            } catch (e) {
                if (e?.status === 413) {
                    return createJsonResponse(
                        { success: false, message: e.message, error: e.message },
                        413
                    );
                }
                return createJsonResponse({ success: false, message: '请求数据格式错误' }, 400);
            }

            if (isAtomicSubscriptionStorage(storageAdapter)) {
                const metadata = requireMutationMetadata(body, request);
                const templates = validateStrictRuleTemplates(body?.templates);
                const result = await storageAdapter.commitDomainOperations({
                    ...metadata,
                    domains: { ruleTemplates: templates },
                });
                return createJsonResponse({
                    success: true,
                    data: result.snapshot.ruleTemplates,
                    version: result.snapshot.version,
                    receipt: result.receipt,
                    replayed: result.replayed,
                    subscriptionProtocol: storageAdapter.subscriptionProtocol,
                });
            }
            const templates = normalizeCustomRuleTemplates(body?.templates || body?.data || []);
            await storageAdapter.put(KV_KEY_RULE_TEMPLATES, templates);
            return createJsonResponse({
                success: true,
                message: '自定义规则模板已保存',
                data: templates,
            });
        }

        return createErrorResponse('Method Not Allowed', 405);
    } catch (error) {
        if (isAtomicSubscriptionRequested(env)) {
            const failure = getProtocolError(error);
            return createJsonResponse(
                { success: false, code: failure.code, message: failure.message },
                failure.status
            );
        }
        console.error('[RuleTemplates] request failed:', error);
        return createJsonResponse(
            {
                success: false,
                message: `自定义规则模板操作失败: ${error.message || '服务器内部错误'}`,
            },
            500
        );
    }
}
