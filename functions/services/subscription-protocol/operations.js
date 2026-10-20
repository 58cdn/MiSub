import {
    SUBSCRIPTION_EDIT_FIELDS,
    PROFILE_EDIT_FIELDS,
    RUNTIME_FIELDS,
} from '../../../src/shared/subscription-edit-operations.js';
import { protocolError } from './errors.js';

export const PROTOCOL_LIMITS = Object.freeze({
    bytes: 262144,
    domainBytes: 1048576,
    transactionBytes: 2621440,
    items: 1000,
    operations: 2000,
});
export { RUNTIME_FIELDS };
const editable = {
    subscriptions: new Set(SUBSCRIPTION_EDIT_FIELDS),
    profiles: new Set(PROFILE_EDIT_FIELDS),
};
const runtimeFields = new Set(RUNTIME_FIELDS);
const ignoredIdentity = new Set([
    ...RUNTIME_FIELDS,
    '_observedAt',
    '_observationTimes',
    'name',
    'description',
    'remark',
    'note',
    'notes',
    'group',
    'colorTag',
    'website',
    'sortIndex',
    'createdAt',
    'updatedAt',
    'isUpdating',
    'downloadCount',
]);
export const isRecord = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);
export const validId = (id) =>
    typeof id === 'string' && id.trim().length > 0 && id.length <= 256 && id !== 'main';

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (isRecord(value))
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, stable(value[key])])
        );
    return value;
}

export function canonicalJson(value, maxBytes = PROTOCOL_LIMITS.bytes) {
    try {
        const result = JSON.stringify(stable(value));
        if (!result) throw protocolError('invalid_data');
        if (new TextEncoder().encode(result).byteLength > maxBytes)
            throw protocolError('capacity_exceeded');
        return result;
    } catch (error) {
        if (error?.code) throw error;
        throw protocolError('invalid_data');
    }
}

export async function hashValue(value, maxBytes) {
    const bytes = new TextEncoder().encode(canonicalJson(value, maxBytes));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function validateDomains(value) {
    if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !['settings', 'ruleTemplates'].includes(key))
    )
        throw protocolError('invalid_data');
    if (Object.hasOwn(value, 'settings')) {
        if (!isRecord(value.settings)) throw protocolError('invalid_data');
        if (value.settings.storageType !== undefined && value.settings.storageType !== 'd1')
            throw protocolError('authority_mismatch');
        canonicalJson(value.settings, PROTOCOL_LIMITS.domainBytes);
    }
    if (Object.hasOwn(value, 'ruleTemplates')) {
        if (!Array.isArray(value.ruleTemplates)) throw protocolError('invalid_data');
        const ids = new Set();
        for (const rule of value.ruleTemplates) {
            if (!isRecord(rule) || !validId(rule.id) || ids.has(rule.id))
                throw protocolError('invalid_data');
            ids.add(rule.id);
        }
        canonicalJson(value.ruleTemplates, PROTOCOL_LIMITS.domainBytes);
    }
    return JSON.parse(canonicalJson(value, PROTOCOL_LIMITS.transactionBytes));
}

export async function captureSubscriptionIdentity(subscription) {
    if (
        !isRecord(subscription) ||
        !validId(subscription.id) ||
        typeof subscription._writeGeneration !== 'string'
    )
        throw protocolError('invalid_data');
    return hashValue(
        Object.fromEntries(
            Object.entries(subscription).filter(([key]) => !ignoredIdentity.has(key))
        )
    );
}

export function validateSnapshot(snapshot, { requireGeneration = true } = {}) {
    for (const collection of ['subscriptions', 'profiles']) {
        if (
            !Array.isArray(snapshot?.[collection]) ||
            snapshot[collection].length > PROTOCOL_LIMITS.items
        )
            throw protocolError('invalid_data');
        const ids = new Set();
        for (const item of snapshot[collection]) {
            if (!isRecord(item) || !validId(item.id) || ids.has(item.id))
                throw protocolError('invalid_data');
            if (
                collection === 'subscriptions' &&
                requireGeneration &&
                typeof item._writeGeneration !== 'string'
            )
                throw protocolError('migration_required');
            ids.add(item.id);
        }
    }
    const ids = new Set(snapshot.subscriptions.map(({ id }) => id));
    for (const profile of snapshot.profiles) {
        for (const field of ['subscriptions', 'manualNodes']) {
            if (profile[field] === undefined) continue;
            if (
                !Array.isArray(profile[field]) ||
                new Set(profile[field]).size !== profile[field].length ||
                profile[field].some((id) => !ids.has(id))
            )
                throw protocolError('invalid_reference');
        }
    }
    canonicalJson({ subscriptions: snapshot.subscriptions, profiles: snapshot.profiles });
    return snapshot;
}

function fieldsFor(collection, value) {
    if (!isRecord(value) || Object.keys(value).some((key) => !editable[collection].has(key)))
        throw protocolError('invalid_operation');
    for (const [key, item] of Object.entries(value)) {
        if (
            collection === 'subscriptions' &&
            key === 'type' &&
            !['subscription', 'manual_node'].includes(item)
        )
            throw protocolError('invalid_operation');
        if (key === 'url' && (typeof item !== 'string' || !item.trim()))
            throw protocolError('invalid_operation');
        if (key === 'name' && item !== null && typeof item !== 'string')
            throw protocolError('invalid_operation');
        if (
            ['enabled', 'isPublic', 'enableNodeCache', 'plusAsSpace', 'excludeTraffic'].includes(
                key
            ) &&
            item !== null &&
            typeof item !== 'boolean'
        )
            throw protocolError('invalid_operation');
        if (
            ['subscriptions', 'manualNodes', 'tags'].includes(key) &&
            (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))
        )
            throw protocolError('invalid_operation');
    }
    return JSON.parse(canonicalJson(value));
}

export function validateOperations(operations) {
    if (!Array.isArray(operations) || operations.length > PROTOCOL_LIMITS.operations)
        throw protocolError('invalid_operation');
    const normalized = JSON.parse(canonicalJson(operations));
    for (const op of normalized) {
        if (!isRecord(op) || !Object.hasOwn(editable, op.collection))
            throw protocolError('invalid_operation');
        switch (op.type) {
            case 'create': {
                if (!isRecord(op.item) || !validId(op.item.id))
                    throw protocolError('invalid_operation');
                const { id, ...fields } = op.item;
                fieldsFor(op.collection, fields);
                if (
                    op.collection === 'subscriptions' &&
                    (typeof fields.url !== 'string' || !fields.url.trim())
                )
                    throw protocolError('invalid_operation');
                break;
            }
            case 'update':
                if (!validId(op.id)) throw protocolError('invalid_operation');
                fieldsFor(op.collection, op.fields);
                break;
            case 'remove':
            case 'reorder':
                if (
                    !Array.isArray(op.ids) ||
                    op.ids.some((id) => !validId(id)) ||
                    new Set(op.ids).size !== op.ids.length
                )
                    throw protocolError('invalid_operation');
                break;
            case 'link':
            case 'unlink':
                if (
                    op.collection !== 'profiles' ||
                    !validId(op.id) ||
                    !['subscriptions', 'manualNodes'].includes(op.field) ||
                    !Array.isArray(op.ids) ||
                    op.ids.some((id) => !validId(id)) ||
                    new Set(op.ids).size !== op.ids.length
                )
                    throw protocolError('invalid_operation');
                break;
            default:
                throw protocolError('invalid_operation');
        }
    }
    return normalized;
}

export function applyOperations(snapshot, operations, now) {
    const next = structuredClone({
        subscriptions: snapshot.subscriptions,
        profiles: snapshot.profiles,
    });
    const timestamp = new Date(now).toISOString();
    for (const op of operations) {
        const items = next[op.collection];
        const find = (id) => {
            const item = items.find((entry) => entry.id === id);
            if (!item) throw protocolError('unknown_item');
            return item;
        };
        switch (op.type) {
            case 'create':
                if (items.some((item) => item.id === op.item.id))
                    throw protocolError('item_exists');
                items.push({
                    ...op.item,
                    sortIndex: items.length,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    ...(op.collection === 'subscriptions'
                        ? { _writeGeneration: crypto.randomUUID(), _observedAt: 0 }
                        : {}),
                });
                break;
            case 'update':
                Object.assign(find(op.id), op.fields, { updatedAt: timestamp });
                break;
            case 'remove': {
                for (const id of op.ids) find(id);
                const removed = new Set(op.ids);
                next[op.collection] = items.filter(({ id }) => !removed.has(id));
                if (op.collection === 'subscriptions')
                    for (const profile of next.profiles) {
                        for (const field of ['subscriptions', 'manualNodes'])
                            if (Array.isArray(profile[field]))
                                profile[field] = profile[field].filter((id) => !removed.has(id));
                    }
                break;
            }
            case 'reorder':
                if (op.ids.length !== items.length) throw protocolError('invalid_operation');
                next[op.collection] = op.ids.map((id, index) => ({
                    ...find(id),
                    sortIndex: index,
                }));
                break;
            case 'link':
            case 'unlink': {
                const item = find(op.id);
                const references = new Set(item[op.field] ?? []);
                for (const id of op.ids) {
                    if (!next.subscriptions.some((entry) => entry.id === id))
                        throw protocolError('unknown_item');
                    if (op.type === 'link') references.add(id);
                    else references.delete(id);
                }
                item[op.field] = [...references];
                item.updatedAt = timestamp;
                break;
            }
        }
    }
    return validateSnapshot(next);
}

export function validateRuntimeObservation(value) {
    if (
        !isRecord(value) ||
        !validId(value.id) ||
        !/^[a-f0-9]{64}$/.test(value.identity ?? '') ||
        ![0, 1].includes(value.requestPolicy) ||
        !Number.isSafeInteger(value.observedAt) ||
        value.observedAt < 0 ||
        !isRecord(value.fields) ||
        !Object.keys(value.fields).length ||
        Object.keys(value.fields).some((key) => !runtimeFields.has(key))
    )
        throw protocolError('invalid_operation');
    for (const key of [
        'nodeCount',
        'lastGoodNodeCount',
        'lastNotifiedExpire',
        'lastNotifiedTraffic',
    ]) {
        if (
            value.fields[key] !== undefined &&
            (!Number.isFinite(value.fields[key]) || value.fields[key] < 0)
        )
            throw protocolError('invalid_operation');
    }
    if (
        value.fields.userInfo !== undefined &&
        value.fields.userInfo !== null &&
        !isRecord(value.fields.userInfo)
    )
        throw protocolError('invalid_operation');
    return JSON.parse(
        canonicalJson({
            id: value.id,
            identity: value.identity,
            requestPolicy: value.requestPolicy,
            observedAt: value.observedAt,
            fields: value.fields,
        })
    );
}

export async function applyObservation(snapshot, observation) {
    if (snapshot.requestPolicy !== observation.requestPolicy)
        throw protocolError('identity_conflict');
    const next = structuredClone({
        subscriptions: snapshot.subscriptions,
        profiles: snapshot.profiles,
    });
    const item = next.subscriptions.find(({ id }) => id === observation.id);
    if (!item) throw protocolError('unknown_item');
    if ((await captureSubscriptionIdentity(item)) !== observation.identity)
        throw protocolError('identity_conflict');
    const clocks = isRecord(item._observationTimes) ? item._observationTimes : {};
    if (
        Object.keys(observation.fields).some(
            (field) => clocks[field] !== undefined && observation.observedAt <= clocks[field]
        )
    )
        throw protocolError('observation_stale');
    Object.assign(item, observation.fields, {
        _observedAt: Math.max(item._observedAt ?? 0, observation.observedAt),
        _observationTimes: {
            ...clocks,
            ...Object.fromEntries(
                Object.keys(observation.fields).map((field) => [field, observation.observedAt])
            ),
        },
    });
    return validateSnapshot(next);
}
