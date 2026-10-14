const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$(?![\s\S])/;
const REVISION = /^(?:[a-f0-9]{40}|source)$(?![\s\S])/;
const PLATFORMS = new Set([
    'linux-amd64',
    'linux-arm64',
    'darwin-amd64',
    'darwin-arm64',
    'windows-amd64',
]);
const validVersion = (value, prefix = false) =>
    typeof value === 'string' &&
    value.length <= 64 &&
    VERSION.test(prefix && value.startsWith('v') ? value.slice(1) : value);

// Only completed tasks can display their own bounded detector declaration.
export function executionSnapshotView(metadata, state) {
    if (state === 'queued' || state === 'running') return { status: 'pending', metadata: null };
    if (state === 'cancelled' || state === 'expired') return { status: 'stopped', metadata: null };
    if (state !== 'done' || metadata === null || metadata === undefined)
        return { status: 'unavailable', metadata: null };
    if (
        typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        metadata.schemaVersion !== 1 ||
        metadata.source !== 'detector_reported' ||
        !validVersion(metadata.wrapperVersion) ||
        typeof metadata.wrapperRevision !== 'string' ||
        !REVISION.test(metadata.wrapperRevision) ||
        !PLATFORMS.has(metadata.platform) ||
        !Number.isSafeInteger(metadata.ruleSetVersion) ||
        metadata.ruleSetVersion < 1 ||
        metadata.ruleSetVersion > 65535 ||
        (metadata.kernelLockVersion !== undefined &&
            !validVersion(metadata.kernelLockVersion, true))
    ) {
        return { status: 'invalid', metadata: null };
    }
    return {
        status: 'recorded',
        metadata: {
            schemaVersion: 1,
            source: 'detector_reported',
            wrapperVersion: metadata.wrapperVersion,
            wrapperRevision: metadata.wrapperRevision,
            platform: metadata.platform,
            ...(metadata.kernelLockVersion === undefined
                ? {}
                : { kernelLockVersion: metadata.kernelLockVersion }),
            ruleSetVersion: metadata.ruleSetVersion,
        },
    };
}
