export const PROBE_CAPABILITY_FRESHNESS_MS = 300000;

const emptyDeclaration = (state) => ({ state, observationsVersion: null, capabilities: null });
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailableStates = new Set([
    'missing',
    'unsupported_schema',
    'invalid_declaration',
    'conflicting_versions',
]);

// Each claim is a complete declaration; older persisted claims never fill gaps.
export function normalizeClaimCapabilities(info = {}) {
    if (!record(info)) return emptyDeclaration('invalid_declaration');
    const hasLegacy = Object.hasOwn(info, 'observationsVersion');
    if (!Object.hasOwn(info, 'capabilities')) {
        if (!hasLegacy) return emptyDeclaration('missing');
        return info.observationsVersion === 1
            ? { state: 'legacy', observationsVersion: 1, capabilities: null }
            : emptyDeclaration('invalid_declaration');
    }
    const value = info.capabilities;
    if (
        !record(value) ||
        !Object.hasOwn(value, 'schemaVersion') ||
        !Number.isSafeInteger(value.schemaVersion) ||
        value.schemaVersion <= 0
    ) {
        return emptyDeclaration('invalid_declaration');
    }
    if (value.schemaVersion !== 1) return emptyDeclaration('unsupported_schema');
    if (!Object.hasOwn(value, 'observationsVersion') || value.observationsVersion !== 1) {
        return emptyDeclaration('invalid_declaration');
    }
    if (hasLegacy && info.observationsVersion !== 1)
        return emptyDeclaration('conflicting_versions');
    const capabilities = { schemaVersion: 1, observationsVersion: 1 };
    // The optional catalog is a fixed identifier, not a client-defined list.
    // Unknown catalogs cannot alter the independent observations protocol.
    if (Object.hasOwn(value, 'catalogVersion') && value.catalogVersion === 1)
        capabilities.catalogVersion = 1;
    return { state: 'declared', observationsVersion: 1, capabilities };
}

const validTimestamp = (value, checkedAt) =>
    Number.isSafeInteger(value) && value > 0 && value <= checkedAt;

// Freshness describes the age of the recorded claim, not current capabilities.
export function agentRuntimeView(row, checkedAt, revokedAt) {
    const output = { lastHeartbeatAt: null, capabilities: null };
    if (!record(row) || !Number.isSafeInteger(checkedAt) || checkedAt <= 0) return output;
    if (validTimestamp(row.last_heartbeat_at, checkedAt))
        output.lastHeartbeatAt = row.last_heartbeat_at;
    if (revokedAt !== null || !validTimestamp(row.claim_received_at, checkedAt)) return output;

    const state = row.declaration_state;
    let catalogVersion;
    if (state === 'declared') {
        if (
            row.observations_version !== 1 ||
            typeof row.capabilities_json !== 'string' ||
            row.capabilities_json.length > 128
        )
            return output;
        let value;
        try {
            value = JSON.parse(row.capabilities_json);
        } catch {
            return output;
        }
        const normalized = normalizeClaimCapabilities({ capabilities: value });
        if (normalized.state !== 'declared') return output;
        catalogVersion = normalized.capabilities.catalogVersion;
    } else if (state === 'legacy') {
        if (row.observations_version !== 1 || row.capabilities_json !== null) return output;
    } else if (
        !unavailableStates.has(state) ||
        row.observations_version !== null ||
        row.capabilities_json !== null
    ) {
        return output;
    }
    output.capabilities = {
        source: 'agent_claim',
        state,
        schemaVersion: state === 'declared' ? 1 : null,
        observationsVersion: state === 'declared' || state === 'legacy' ? 1 : null,
        receivedAt: row.claim_received_at,
        freshness:
            checkedAt - row.claim_received_at < PROBE_CAPABILITY_FRESHNESS_MS ? 'fresh' : 'stale',
    };
    if (catalogVersion === 1) output.capabilities.catalogVersion = 1;
    return output;
}
