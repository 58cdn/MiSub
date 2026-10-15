import { PROBE_TYPES, requireValue } from './probe-contract.js';
import { isProbeBuildVersion as version } from '../../src/shared/probe-version.js';

export const EXECUTION_METADATA_VERSION = 1;
const REVISION = /^(?:[a-f0-9]{40}|source)$(?![\s\S])/;
const PLATFORMS = new Set(['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64', 'windows-amd64']);

// Declarations identify the submitting build; they do not attest kernel execution
// or negotiate capabilities. Never copy arbitrary fields from the detector.
export function sanitizeExecutionMetadata(input) {
    if (input === undefined || input === null) return null;
    requireValue(input && typeof input === 'object' && !Array.isArray(input)
        && input.schemaVersion === EXECUTION_METADATA_VERSION
        && version(input.wrapperVersion)
        && typeof input.wrapperRevision === 'string' && REVISION.test(input.wrapperRevision)
        && PLATFORMS.has(input.platform)
        && Number.isSafeInteger(input.ruleSetVersion) && input.ruleSetVersion >= 1 && input.ruleSetVersion <= 65535
        && (input.kernelLockVersion === undefined || version(input.kernelLockVersion, true)), 'invalid_execution_metadata');
    return {
        schemaVersion: EXECUTION_METADATA_VERSION,
        source: 'detector_reported',
        wrapperVersion: input.wrapperVersion,
        wrapperRevision: input.wrapperRevision,
        platform: input.platform,
        ...(input.kernelLockVersion === undefined ? {} : { kernelLockVersion: input.kernelLockVersion }),
        ruleSetVersion: input.ruleSetVersion,
    };
}

// Keep the legacy checks object and its checks-only idempotency digest. Extension
// fields inside each Check remain readable by older backends and clients.
export function encodeExecutionResult(checks, metadata) {
    if (!metadata) return JSON.stringify(checks);
    return JSON.stringify(Object.fromEntries(Object.entries(checks).map(([type, check]) => [
        type, { ...check, executionMetadata: metadata },
    ])));
}

export function decodeExecutionResult(encoded) {
    if (!encoded) return { checks: null, executionMetadata: null, metadataState: 'legacy' };
    let stored;
    try { stored = JSON.parse(encoded); } catch { requireValue(false, 'invalid_stored_result', 500); }
    requireValue(stored && typeof stored === 'object' && !Array.isArray(stored), 'invalid_stored_result', 500);
    const checks = {};
    let snapshot = null;
    let consistent = true;
    let present = 0;
    const entries = Object.entries(stored);
    for (const [type, value] of entries) {
        requireValue(PROBE_TYPES.includes(type) && value && typeof value === 'object' && !Array.isArray(value), 'invalid_stored_result', 500);
        if (Object.hasOwn(value, 'executionMetadata')) present++;
        const { executionMetadata, ...check } = value;
        checks[type] = check;
        let candidate = null;
        try {
            if (executionMetadata?.source === 'detector_reported') candidate = sanitizeExecutionMetadata(executionMetadata);
        } catch { /* Invalid stored metadata stays unknown and is never exposed. */ }
        if (!candidate || (snapshot && JSON.stringify(snapshot) !== JSON.stringify(candidate))) consistent = false;
        if (!snapshot && candidate) snapshot = candidate;
    }
    const metadataState = !present ? 'legacy' : present === entries.length && consistent ? 'snapshot' : 'invalid';
    return { checks, executionMetadata: metadataState === 'snapshot' ? snapshot : null, metadataState };
}

export function executionResultView(encoded) {
    const { checks, executionMetadata } = decodeExecutionResult(encoded);
    return { checks, executionMetadata };
}
