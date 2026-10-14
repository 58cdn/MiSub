const statuses = {
    version_required: 428,
    legacy_write_blocked: 428,
    revision_conflict: 409,
    epoch_conflict: 409,
    operation_id_conflict: 409,
    identity_conflict: 409,
    observation_stale: 409,
    unknown_item: 409,
    item_exists: 409,
    invalid_operation: 400,
    invalid_data: 400,
    invalid_reference: 400,
    invalid_version: 400,
    capacity_exceeded: 413,
    unsupported_restore_scope: 400,
    storage_unavailable: 503,
    atomic_backend_required: 503,
    authority_mismatch: 503,
    schema_not_ready: 503,
    receipt_capacity: 503,
    invalid_protocol_mode: 503,
    migration_required: 503,
};

export function protocolError(code, status) {
    const safeCode = Object.hasOwn(statuses, code) ? code : 'storage_unavailable';
    const error = new Error(safeCode);
    error.code = safeCode;
    error.status = status ?? statuses[safeCode];
    return error;
}

export function getProtocolError(error) {
    const code = Object.hasOwn(statuses, error?.code) ? error.code : 'storage_unavailable';
    return { code, status: statuses[code], message: code };
}

export const validToken = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const validVersion = (value) =>
    value && validToken(value.epoch) && Number.isSafeInteger(value.revision) && value.revision >= 0;

export function requireMutationMetadata(payload, request) {
    let baseVersion = payload?.baseVersion,
        operationId = payload?.operationId;
    if (baseVersion === undefined && request?.headers?.has('X-MiSub-Epoch')) {
        const raw = request.headers.get('X-MiSub-Revision');
        baseVersion = {
            epoch: request.headers.get('X-MiSub-Epoch'),
            revision: /^\d+$/.test(raw ?? '') ? Number(raw) : NaN,
        };
    }
    if (operationId === undefined)
        operationId = request?.headers?.get('X-MiSub-Operation-Id') ?? undefined;
    if (!baseVersion || operationId === undefined) throw protocolError('version_required');
    if (!validVersion(baseVersion) || !validToken(operationId))
        throw protocolError('invalid_version');
    return {
        baseVersion: { epoch: baseVersion.epoch, revision: baseVersion.revision },
        operationId,
    };
}

export function isAtomicSubscriptionRequested(env) {
    const mode = env?.MISUB_SUBSCRIPTION_PROTOCOL;
    return mode !== undefined && mode !== null && mode !== '' && mode !== 'legacy';
}

export function resolveSubscriptionProtocol(env) {
    if (!isAtomicSubscriptionRequested(env)) return null;
    if (env.MISUB_SUBSCRIPTION_PROTOCOL !== 'd1-v1') throw protocolError('invalid_protocol_mode');
    if (!env.MISUB_DB?.prepare || !env.MISUB_DB?.batch)
        throw protocolError('atomic_backend_required');
    if (!validToken(env.MISUB_SUBSCRIPTION_AUTHORITY)) throw protocolError('authority_mismatch');
    return { db: env.MISUB_DB, authority: env.MISUB_SUBSCRIPTION_AUTHORITY };
}

export const isAtomicSubscriptionStorage = (storage) => storage?.subscriptionProtocol === 'd1-v1';
