export const SUBSCRIPTION_EDIT_FIELDS = Object.freeze([
    'name',
    'url',
    'enabled',
    'exclude',
    'customUserAgent',
    'fetchProxy',
    'enableNodeCache',
    'plusAsSpace',
    'excludeTraffic',
    'website',
    'notes',
    'group',
    'colorTag',
    'airportIdentity',
    'protocol',
    'source',
    'description',
    'remark',
    'remarks',
    'note',
    'customId',
    'tags',
]);

export const PROFILE_EDIT_FIELDS = Object.freeze([
    'name',
    'enabled',
    'isPublic',
    'description',
    'customId',
    'subscriptions',
    'manualNodes',
    'transformConfigMode',
    'transformConfig',
    'ruleLevel',
    'expiresAt',
    'operators',
    'prefixSettings',
    'subconverter',
    'target',
]);

export const RUNTIME_FIELDS = Object.freeze([
    'nodeCount',
    'userInfo',
    'lastError',
    'lastUpdate',
    'lastUpdated',
    'lastGoodNodeCount',
    'detectedName',
    'nodeCountChange',
    'lastNotifiedExpire',
    'lastNotifiedTraffic',
]);

const observationConfigFields = [
    'url',
    'fetchProxy',
    'customUserAgent',
    'plusAsSpace',
    'enableNodeCache',
];

const fieldsFor = (collection) =>
    collection === 'subscriptions' ? SUBSCRIPTION_EDIT_FIELDS : PROFILE_EDIT_FIELDS;
const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => equal(value, right[index]))
        );
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
    );
};

export function isSubscriptionVersion(version) {
    return (
        isRecord(version) &&
        typeof version.epoch === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(version.epoch) &&
        Number.isSafeInteger(version.revision) &&
        version.revision >= 0
    );
}

export function createSubscriptionOperationId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function editableSubscriptionFields(collection, item) {
    const values = {};
    for (const field of fieldsFor(collection)) {
        let value = item[field];
        if (collection === 'profiles' && field === 'ruleLevel') {
            value = item.ruleLevel ?? item.clashRuleLevel;
        }
        if (value !== undefined) values[field] = clone(value);
    }
    return values;
}

export function hasObservationConfigurationChange(before, after) {
    return (
        !before ||
        !after ||
        observationConfigFields.some((field) => !equal(before[field], after[field]))
    );
}

function indexed(items) {
    if (!Array.isArray(items)) throw new Error('invalid_edit_collection');
    const result = new Map();
    for (const item of items) {
        if (
            !isRecord(item) ||
            typeof item.id !== 'string' ||
            !item.id.trim() ||
            result.has(item.id)
        ) {
            throw new Error('invalid_edit_identity');
        }
        result.set(item.id, item);
    }
    return result;
}

/** Explicit changes relative to a complete acknowledged baseline. Runtime fields are excluded. */
export function buildSubscriptionEditOperations(baseline, edited) {
    const operations = [];
    for (const collection of ['subscriptions', 'profiles']) {
        const before = indexed(baseline[collection]);
        const after = indexed(edited[collection]);
        const removed = [...before.keys()].filter((id) => !after.has(id));
        if (removed.length) operations.push({ type: 'remove', collection, ids: removed });
        for (const [id, item] of after) {
            const fields = editableSubscriptionFields(collection, item);
            if (!before.has(id)) {
                operations.push({ type: 'create', collection, item: { id, ...fields } });
                continue;
            }
            const old = editableSubscriptionFields(collection, before.get(id));
            const changed = {};
            for (const field of fieldsFor(collection)) {
                if (!equal(old[field], fields[field])) changed[field] = fields[field] ?? null;
            }
            if (Object.keys(changed).length)
                operations.push({ type: 'update', collection, id, fields: changed });
        }
        const nextIds = [...after.keys()];
        if (!equal([...before.keys()], nextIds) && nextIds.length) {
            operations.push({ type: 'reorder', collection, ids: nextIds });
        }
    }
    return operations;
}

/** Reapply only edits made after submission; do not interpret later remote additions as deletes. */
export function rebaseSubscriptionEdits(
    submitted,
    edited,
    confirmed,
    { checkConflicts = true } = {}
) {
    const result = clone(confirmed);
    const operations = buildSubscriptionEditOperations(submitted, edited);
    for (const operation of operations) {
        const { collection, type } = operation;
        const current = indexed(result[collection]);
        const original = indexed(submitted[collection]);
        if (type === 'create') {
            if (current.has(operation.item.id)) return null;
            result[collection].push(clone(operation.item));
        } else if (type === 'update') {
            const target = current.get(operation.id);
            if (!target) return null;
            const currentFields = editableSubscriptionFields(collection, target);
            const originalFields = editableSubscriptionFields(
                collection,
                original.get(operation.id)
            );
            for (const [field, value] of Object.entries(operation.fields)) {
                if (
                    checkConflicts &&
                    !equal(currentFields[field], originalFields[field]) &&
                    !equal(currentFields[field], value)
                )
                    return null;
            }
            const editedItem = edited[collection].find((item) => item.id === operation.id);
            if (
                collection === 'subscriptions' &&
                hasObservationConfigurationChange(target, editedItem)
            ) {
                for (const field of RUNTIME_FIELDS) {
                    if (Object.hasOwn(editedItem, field)) target[field] = clone(editedItem[field]);
                    else delete target[field];
                }
            }
            Object.assign(target, clone(operation.fields));
        } else if (type === 'remove') {
            for (const id of operation.ids) {
                if (
                    checkConflicts &&
                    current.has(id) &&
                    !equal(
                        editableSubscriptionFields(collection, current.get(id)),
                        editableSubscriptionFields(collection, original.get(id))
                    )
                )
                    return null;
            }
            const removed = new Set(operation.ids);
            result[collection] = result[collection].filter((item) => !removed.has(item.id));
        } else if (type === 'reorder') {
            const ids = new Set(operation.ids);
            if (operation.ids.some((id) => !current.has(id))) return null;
            const known = new Set(
                [...original.keys()].filter((id) => ids.has(id) && current.has(id))
            );
            const originalOrder = [...original.keys()].filter((id) => known.has(id));
            const remoteOrder = [...current.keys()].filter((id) => known.has(id));
            const desiredOrder = operation.ids.filter((id) => known.has(id));
            if (
                checkConflicts &&
                !equal(originalOrder, remoteOrder) &&
                !equal(desiredOrder, remoteOrder)
            )
                return null;
            let index = 0;
            result[collection] = result[collection].map((item) =>
                ids.has(item.id) ? current.get(operation.ids[index++]) : item
            );
        }
    }
    return result;
}
