import {
    createSubscriptionOperationId,
    isSubscriptionVersion,
} from './subscription-edit-operations.js';

export const cloneDomainData = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const sameDomainData = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const isDomainRecord = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
export const isStrictSettingsData = (value) => isDomainRecord(value) && value.storageType === 'd1';

export function domainMutationMetadata(snapshot, { restore = false } = {}) {
    if (snapshot?.subscriptionProtocol !== 'd1-v1') return {};
    if (!isSubscriptionVersion(snapshot.version)) throw new Error('version_required');
    return {
        baseVersion: { ...snapshot.version },
        operationId: createSubscriptionOperationId(),
        ...(restore ? { nextEpoch: createSubscriptionOperationId() } : {}),
    };
}

export function validDomainResponse(result, validData, { strict = false } = {}) {
    return (
        result?.success === true &&
        validData(result.data) &&
        (!strict || result.subscriptionProtocol === 'd1-v1') &&
        (result.subscriptionProtocol === undefined ||
            result.subscriptionProtocol === 'legacy' ||
            (result.subscriptionProtocol === 'd1-v1' && isSubscriptionVersion(result.version)))
    );
}

export function validDomainAcknowledgement(result, request, validData) {
    if (!request.baseVersion) return result?.success === true;
    const receipt = result?.receipt;
    return (
        validDomainResponse(result, validData, { strict: true }) &&
        receipt?.operationId === request.operationId &&
        isSubscriptionVersion(receipt.version) &&
        receipt.version.epoch === request.baseVersion.epoch &&
        result.version.epoch === receipt.version.epoch &&
        receipt.version.revision > request.baseVersion.revision &&
        result.version.revision >= receipt.version.revision
    );
}

function identifiedArray(value) {
    return (
        Array.isArray(value) &&
        value.every(
            (item) => isDomainRecord(item) && typeof item.id === 'string' && item.id.trim()
        ) &&
        new Set(value.map((item) => item.id)).size === value.length
    );
}

// Replay only edits made after a request began onto its confirmed server snapshot.
export function replayDomainEdits(before, current, confirmed) {
    if (sameDomainData(before, current)) return cloneDomainData(confirmed);
    if (isDomainRecord(before) && isDomainRecord(current) && isDomainRecord(confirmed)) {
        const result = cloneDomainData(confirmed);
        for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
            if (sameDomainData(before[key], current[key])) continue;
            if (!(key in current)) delete result[key];
            else if (!(key in before) || !(key in confirmed))
                result[key] = cloneDomainData(current[key]);
            else result[key] = replayDomainEdits(before[key], current[key], confirmed[key]);
        }
        return result;
    }
    if (identifiedArray(before) && identifiedArray(current) && identifiedArray(confirmed)) {
        const oldById = new Map(before.map((item) => [item.id, item]));
        const currentById = new Map(current.map((item) => [item.id, item]));
        const result = confirmed
            .filter((item) => !oldById.has(item.id) || currentById.has(item.id))
            .map((item) => {
                const old = oldById.get(item.id),
                    edited = currentById.get(item.id);
                return old && edited ? replayDomainEdits(old, edited, item) : cloneDomainData(item);
            });
        for (const item of current) {
            const index = result.findIndex((entry) => entry.id === item.id);
            if (!oldById.has(item.id)) {
                if (index < 0) result.push(cloneDomainData(item));
                else result[index] = cloneDomainData(item);
            } else if (index < 0 && !sameDomainData(oldById.get(item.id), item)) {
                result.push(cloneDomainData(item));
            }
        }
        const oldOrder = before.filter((item) => currentById.has(item.id)).map((item) => item.id);
        const nextOrder = current.filter((item) => oldById.has(item.id)).map((item) => item.id);
        if (!sameDomainData(oldOrder, nextOrder) || current.some((item) => !oldById.has(item.id))) {
            const rank = new Map(current.map((item, index) => [item.id, index]));
            result.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
        }
        return result;
    }
    return cloneDomainData(current);
}

export function acknowledgedDomainVersion(result, hasPendingEdits) {
    return { ...(hasPendingEdits ? result.receipt.version : result.version) };
}
