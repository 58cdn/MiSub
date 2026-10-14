import { StorageFactory } from '../storage-adapter.js';
import { KV_KEY_SETTINGS } from './config.js';
import { createJsonResponse, JSON_BODY_LIMITS, readJsonWithLimit } from './utils.js';
import {
    isAtomicSubscriptionStorage,
    isAtomicSubscriptionRequested,
    getProtocolError,
    protocolError,
    requireMutationMetadata,
    captureSubscriptionIdentity,
    commitRuntimeObservation,
} from '../services/subscription-protocol/index.js';
import {
    isManualNode,
    isRemoteSubscription,
    detectNodeProtocol,
    toExternalSubscription,
    toExternalManualNode,
    toExternalProfile,
} from './external-api-mappers.js';

export { isAtomicSubscriptionStorage, isAtomicSubscriptionRequested };

export async function getExternalStorageAdapter(env) {
    if (env?.__TEST_STORAGE_ADAPTER) return env.__TEST_STORAGE_ADAPTER;
    const storageType = await StorageFactory.getStorageType(env);
    return StorageFactory.createAdapter(env, storageType);
}

export function createRequestId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return `req_${crypto.randomUUID()}`;
        }
    } catch {}
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createExternalSuccess(data, status = 200, meta = undefined) {
    const body = { success: true, data };
    if (meta) body.meta = meta;
    return createJsonResponse(body, status);
}

export function createExternalError(code, message, status = 400, details = undefined) {
    const error = { code, message };
    if (details !== undefined) error.details = details;
    return createJsonResponse({ success: false, error }, status);
}

export function parseBooleanParam(value) {
    if (value == null || value === '') return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
}

export function parsePagination(url) {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize')) || 50));
    return { page, pageSize };
}

export function buildListMeta({ page, pageSize, total }) {
    return { page, pageSize, total, requestId: createRequestId() };
}

export function paginate(items, page, pageSize) {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
}

export async function readExternalJson(request) {
    try {
        return await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
    } catch (error) {
        throw Object.assign(new Error(error?.message || 'Invalid JSON'), {
            status: error?.status || 400,
            code: 'invalid_json',
        });
    }
}

export async function getExternalApiSettings(env, storageAdapter = null) {
    const adapter = storageAdapter || (await getExternalStorageAdapter(env));
    const settings = (await adapter.get(KV_KEY_SETTINGS)) || {};
    return settings.externalApi || {};
}

export function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item || '').trim()).filter(Boolean);
}

export function sortBySortIndex(items) {
    return [...items].sort((a, b) => {
        const aIndex = Number(a?.sortIndex) || 0;
        const bIndex = Number(b?.sortIndex) || 0;
        return aIndex - bIndex;
    });
}

export function createExternalProtocolError(error) {
    const failure = getProtocolError(
        error?.code === 'invalid_json'
            ? protocolError(error?.status === 413 ? 'capacity_exceeded' : 'invalid_data')
            : error
    );
    return createExternalError(failure.code, failure.message, failure.status);
}

function atomicMeta(snapshot, result = null) {
    return {
        version: snapshot.version,
        subscriptionProtocol: 'd1-v1',
        ...(result ? { receipt: result.receipt, replayed: result.replayed } : {}),
    };
}

function strictIds(value) {
    if (
        !Array.isArray(value) ||
        value.some((id) => typeof id !== 'string' || !id.trim()) ||
        new Set(value).size !== value.length
    ) {
        throw protocolError('invalid_data');
    }
    return value;
}

function atomicExternalFields(kind, payload, creating) {
    const fields = {};
    const strings =
        kind === 'profile'
            ? ['name', 'description', 'customId', 'target']
            : kind === 'manual_node'
              ? ['name', 'url', 'group', 'remarks']
              : ['name', 'url', 'group', 'userAgent', 'proxy'];
    const allowed = new Set([
        ...strings,
        'enabled',
        'id',
        'baseVersion',
        'operationId',
        ...(kind === 'profile' ? ['isPublic', 'subscriptionIds', 'manualNodeIds'] : ['tags']),
    ]);
    if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).some((key) => !allowed.has(key))
    )
        throw protocolError('invalid_data');
    for (const key of strings) {
        if (payload[key] === undefined) continue;
        if (typeof payload[key] !== 'string') throw protocolError('invalid_data');
        fields[key] = payload[key].trim();
    }
    for (const key of kind === 'profile' ? ['enabled', 'isPublic'] : ['enabled']) {
        if (payload[key] === undefined) continue;
        if (typeof payload[key] !== 'boolean') throw protocolError('invalid_data');
        fields[key] = payload[key];
    }
    if (payload.tags !== undefined) fields.tags = strictIds(payload.tags);
    if (kind === 'profile') {
        if (payload.subscriptionIds !== undefined)
            fields.subscriptions = strictIds(payload.subscriptionIds);
        if (payload.manualNodeIds !== undefined)
            fields.manualNodes = strictIds(payload.manualNodeIds);
    }
    if (kind === 'subscription') {
        if (fields.userAgent !== undefined) {
            fields.customUserAgent = fields.userAgent;
            delete fields.userAgent;
        }
        if (fields.proxy !== undefined) {
            fields.fetchProxy = fields.proxy;
            delete fields.proxy;
        }
    }
    if ((creating || fields.name !== undefined) && !fields.name)
        throw protocolError('invalid_data');
    if (kind !== 'profile' && (creating || fields.url !== undefined)) {
        if (!(kind === 'subscription' ? isRemoteSubscription(fields) : isManualNode(fields)))
            throw protocolError('invalid_data');
    }
    return fields;
}

async function atomicRequestPayload(request) {
    if (request.method === 'GET') return {};
    if (request.body === null) return {};
    try {
        return await readExternalJson(request);
    } catch {
        throw protocolError('invalid_data');
    }
}

async function validateAtomicProfileReferences(storage, metadata, operation) {
    const fields = operation.type === 'create' ? operation.item : operation.fields;
    const references =
        operation.type === 'link' ? { [operation.field]: operation.ids } : fields || {};
    if (references.subscriptions === undefined && references.manualNodes === undefined) return;
    const snapshot = await storage.readSubscriptionSnapshot();
    if (
        snapshot.version.epoch !== metadata.baseVersion.epoch ||
        snapshot.version.revision !== metadata.baseVersion.revision
    )
        return;
    const byId = new Map(snapshot.subscriptions.map((item) => [item.id, item]));
    for (const [field, accepts] of [
        ['subscriptions', isRemoteSubscription],
        ['manualNodes', isManualNode],
    ]) {
        if ((references[field] || []).some((id) => !accepts(byId.get(id))))
            throw protocolError('invalid_reference');
    }
}

async function refreshAtomicExternal(storage, metadata, payload, { kind, id, action, inspect }) {
    if (typeof inspect !== 'function') throw protocolError('atomic_backend_required');
    const snapshot = await storage.readSubscriptionSnapshot();
    if (metadata.baseVersion.epoch !== snapshot.version.epoch)
        throw protocolError('epoch_conflict');
    if (metadata.baseVersion.revision !== snapshot.version.revision)
        throw protocolError('revision_conflict');
    let ids;
    if (kind === 'profile') {
        const profile = snapshot.profiles.find((item) => item.id === id);
        if (!profile) throw protocolError('unknown_item');
        ids = profile.subscriptions || [];
    } else ids = action === 'batch_refresh' ? strictIds(payload.subscriptionIds) : [id];
    if (!ids.length) throw protocolError('invalid_data');
    const targets = ids.map((targetId) => {
        const item = snapshot.subscriptions.find(
            (sub) => sub.id === targetId && isRemoteSubscription(sub)
        );
        if (!item) throw protocolError('unknown_item');
        return item;
    });
    const observations = await Promise.all(
        targets.map(async (item) => {
            const digest =
                targets.length === 1
                    ? null
                    : await crypto.subtle.digest(
                          'SHA-256',
                          new TextEncoder().encode(JSON.stringify([metadata.operationId, item.id]))
                      );
            const operationId = digest
                ? Array.from(new Uint8Array(digest), (byte) =>
                      byte.toString(16).padStart(2, '0')
                  ).join('')
                : metadata.operationId;
            return { item, identity: await captureSubscriptionIdentity(item), operationId };
        })
    );
    const results = [];
    let latest = snapshot;
    for (const { item, identity, operationId } of observations) {
        try {
            const observedAt = Date.now();
            const observation = await inspect(item, {
                requestPolicy: snapshot.requestPolicy,
                canonicalRuntime: true,
            });
            const fields = {
                nodeCount: observation.ok ? observation.nodeCount : 0,
                userInfo: observation.ok ? observation.userInfo : null,
                lastError: observation.ok ? '' : 'subscription_refresh_failed',
                lastUpdate: new Date(observedAt).toISOString(),
            };
            const committed = await commitRuntimeObservation(storage, {
                operationId,
                id: item.id,
                identity,
                observedAt,
                requestPolicy: snapshot.requestPolicy,
                fields,
            });
            if (!committed.applied) throw protocolError(committed.reason);
            latest = committed.snapshot;
            results.push({
                id: item.id,
                success: observation.ok,
                applied: true,
                receipt: committed.receipt,
                replayed: committed.replayed,
            });
        } catch (error) {
            if (targets.length === 1) throw error;
            const failure = getProtocolError(error);
            results.push({
                id: item.id,
                success: false,
                applied: false,
                error: { code: failure.code, message: failure.message },
            });
        }
    }
    return createExternalSuccess(
        {
            results,
            summary: {
                total: results.length,
                applied: results.filter((item) => item.applied).length,
            },
        },
        200,
        atomicMeta(latest)
    );
}

export async function handleAtomicExternalCollection(request, storage, options) {
    try {
        const { kind, id = null, relation = null, action = null } = options;
        const collection = kind === 'profile' ? 'profiles' : 'subscriptions';
        const accepts =
            kind === 'profile'
                ? () => true
                : kind === 'manual_node'
                  ? isManualNode
                  : isRemoteSubscription;
        const mapper =
            kind === 'profile'
                ? toExternalProfile
                : kind === 'manual_node'
                  ? toExternalManualNode
                  : toExternalSubscription;
        if (request.method === 'GET' && !action && !relation) {
            const snapshot = await storage.readSubscriptionSnapshot();
            const all = sortBySortIndex(snapshot[collection].filter(accepts));
            if (id) {
                const item = all.find((entry) => entry.id === id);
                if (!item) return createExternalError('not_found', 'Item not found', 404);
                return createExternalSuccess(mapper(item), 200, atomicMeta(snapshot));
            }
            const url = new URL(request.url);
            const enabled = parseBooleanParam(url.searchParams.get('enabled'));
            const keyword = (url.searchParams.get('keyword') || '').toLowerCase();
            const group = url.searchParams.get('group');
            const protocol = url.searchParams.get('protocol');
            const filtered = all.filter(
                (item) =>
                    (enabled === undefined || (item.enabled !== false) === enabled) &&
                    (!group || item.group === group) &&
                    (!protocol || detectNodeProtocol(item.url) === protocol.toLowerCase()) &&
                    (!keyword ||
                        `${item.name || ''}\n${item.url || ''}\n${item.description || ''}\n${item.customId || ''}`
                            .toLowerCase()
                            .includes(keyword))
            );
            const { page, pageSize } = parsePagination(url);
            return createExternalSuccess(paginate(filtered.map(mapper), page, pageSize), 200, {
                ...buildListMeta({ page, pageSize, total: filtered.length }),
                ...atomicMeta(snapshot),
            });
        }
        if (!['POST', 'PATCH', 'DELETE'].includes(request.method))
            return createExternalError('method_not_allowed', 'Method Not Allowed', 405);
        if (action && request.method !== 'POST')
            return createExternalError('method_not_allowed', 'Method Not Allowed', 405);
        const payload = await atomicRequestPayload(request);
        const metadata = requireMutationMetadata(payload, request);
        if (action === 'refresh' || action === 'batch_refresh')
            return await refreshAtomicExternal(storage, metadata, payload, options);
        if (action) throw protocolError('invalid_operation');
        let operation;
        let itemId = id;
        if (relation) {
            if (
                kind !== 'profile' ||
                !id ||
                !['subscriptions', 'manual-nodes'].includes(relation) ||
                !['POST', 'DELETE'].includes(request.method)
            )
                throw protocolError('invalid_operation');
            operation = {
                type: request.method === 'POST' ? 'link' : 'unlink',
                collection,
                id,
                field: relation === 'subscriptions' ? 'subscriptions' : 'manualNodes',
                ids: strictIds(
                    payload[relation === 'subscriptions' ? 'subscriptionIds' : 'manualNodeIds']
                ),
            };
        } else if (request.method === 'POST' && !id) {
            if (typeof payload.id !== 'string' || !payload.id.trim())
                throw protocolError('invalid_data');
            itemId = payload.id;
            operation = {
                type: 'create',
                collection,
                item: { id: itemId, ...atomicExternalFields(kind, payload, true) },
            };
        } else if (request.method === 'PATCH' && id) {
            if (payload.id !== undefined && payload.id !== id) throw protocolError('invalid_data');
            operation = {
                type: 'update',
                collection,
                id,
                fields: atomicExternalFields(kind, payload, false),
            };
        } else if (request.method === 'DELETE' && id) {
            operation = { type: 'remove', collection, ids: [id] };
        } else throw protocolError('invalid_operation');
        if (id && kind !== 'profile') {
            const snapshot = await storage.readSubscriptionSnapshot();
            const current = snapshot.subscriptions.find((item) => item.id === id);
            if (current && !accepts(current)) throw protocolError('invalid_operation');
        }
        if (kind === 'profile') await validateAtomicProfileReferences(storage, metadata, operation);
        const result = await storage.commitSubscriptionOperations({
            ...metadata,
            operations: [operation],
        });
        const item = result.snapshot[collection].find((entry) => entry.id === itemId);
        const data =
            operation.type === 'remove' ? { deleted: true, id } : item ? mapper(item) : null;
        return createExternalSuccess(
            data,
            operation.type === 'create' ? 201 : 200,
            atomicMeta(result.snapshot, result)
        );
    } catch (error) {
        return createExternalProtocolError(error);
    }
}
