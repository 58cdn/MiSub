const STATES = new Set([
    'declared',
    'legacy',
    'missing',
    'unsupported_schema',
    'invalid_declaration',
    'conflicting_versions',
]);

export function validRuntimeTimestamp(value, checkedAt) {
    return (
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= 8640000000000000 &&
        Number.isSafeInteger(checkedAt) &&
        checkedAt > 0 &&
        checkedAt <= 8640000000000000 &&
        value <= checkedAt
    );
}

// Retain only the server's bounded declaration; current agent data cannot fill gaps.
export function runtimeDeclarationView(value, checkedAt, revoked = false) {
    if (revoked || value === null || value === undefined)
        return { status: 'unavailable', declaration: null };
    if (
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.source !== 'agent_claim' ||
        !STATES.has(value.state) ||
        !validRuntimeTimestamp(value.receivedAt, checkedAt) ||
        !['fresh', 'stale'].includes(value.freshness)
    )
        return { status: 'invalid', declaration: null };
    const versionsValid =
        value.state === 'declared'
            ? value.schemaVersion === 1 && value.observationsVersion === 1
            : value.state === 'legacy'
              ? value.schemaVersion === null && value.observationsVersion === 1
              : value.schemaVersion === null && value.observationsVersion === null;
    if (!versionsValid) return { status: 'invalid', declaration: null };
    const freshnessAtCheck = checkedAt - value.receivedAt < 300000 ? 'fresh' : 'stale';
    if (value.freshness !== freshnessAtCheck) return { status: 'invalid', declaration: null };
    return {
        status: value.state,
        declaration: {
            source: 'agent_claim',
            state: value.state,
            schemaVersion: value.schemaVersion,
            observationsVersion: value.observationsVersion,
            receivedAt: value.receivedAt,
            freshness: value.freshness,
            ...(value.state === 'declared' &&
            Object.hasOwn(value, 'catalogVersion') &&
            value.catalogVersion === 1
                ? { catalogVersion: 1 }
                : {}),
        },
    };
}
