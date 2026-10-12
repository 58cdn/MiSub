/** Versioned, credential-free probe wire contract. */
export const PROBE_TYPES = ['format', 'tcp', 'proxy', 'speed', 'unlock'];
export const PROBE_SERVICES = ['netflix', 'youtube', 'openai', 'claude', 'gemini', 'disney', 'spotify', 'tiktok'];
export const PROBE_STATUSES = ['passed', 'failed', 'timeout', 'blocked', 'unknown', 'unsupported', 'skipped', 'cancelled'];
export const MAX_NODES = 500;
export const MAX_AGENTS = 8;
export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 90000;
export const MAX_JOB_BYTES = 1024 * 1024 * 1024;
const CODES = new Set(['ok', 'invalid_format', 'unsupported_protocol', 'unsupported_transport', 'unsafe_target', 'dns_failed', 'connect_failed', 'tls_failed', 'request_failed', 'http_error', 'deadline', 'cancelled', 'prerequisite_failed', 'kernel_missing', 'kernel_failed', 'probe_inconclusive', 'region_blocked', 'service_reachable', 'native_unlocked', 'originals_only', 'rate_limited', 'traffic_limit', 'task_expired']);

export function probeError(code, status = 400) {
    return Object.assign(new Error(code), { code, status });
}
export function requireValue(condition, code = 'invalid_request', status = 400) {
    if (!condition) throw probeError(code, status);
}
export async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken() {
    return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function normalizeOptions(input, nodeCount, agentCount) {
    requireValue(Array.isArray(input.types) && input.types.length > 0 && input.types.every(x => PROBE_TYPES.includes(x)), 'invalid_types');
    const types = [...new Set(input.types)];
    const o = input.options || {};
    const timeoutMs = o.timeoutMs ?? 5000;
    const downloadBytes = o.downloadBytes ?? 5 * 1024 * 1024;
    requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 15000, 'invalid_timeout');
    requireValue(Number.isInteger(downloadBytes) && downloadBytes >= 65536 && downloadBytes <= 20 * 1024 * 1024, 'invalid_download_limit');
    const services = o.services ?? ['netflix', 'youtube', 'openai'];
    requireValue(Array.isArray(services) && services.length > 0 && services.length <= PROBE_SERVICES.length && services.every(x => PROBE_SERVICES.includes(x)), 'invalid_services');
    const worstCaseDownloadBytes = types.includes('speed') ? nodeCount * agentCount * downloadBytes * MAX_ATTEMPTS : 0;
    requireValue(worstCaseDownloadBytes <= MAX_JOB_BYTES, 'job_traffic_limit');
    if (types.includes('speed')) requireValue(o.allowMetered === true, 'speed_consent_required');
    return { types, options: { timeoutMs, downloadBytes, services: [...new Set(services)], worstCaseDownloadBytes } };
}
export function publicAgent(a) {
    return { id: a.id, name: a.name, createdAt: a.created_at, lastSeen: a.last_seen, revokedAt: a.revoked_at, version: a.version, platform: a.platform };
}
export function sanitizeResult(input, types, services = PROBE_SERVICES) {
    requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_result');
    const cleanCheck = (v) => {
        requireValue(v && typeof v === 'object' && PROBE_STATUSES.includes(v.status), 'invalid_result_status');
        requireValue(CODES.has(v.code), 'invalid_result_code');
        if (v.code === 'rate_limited' || v.httpStatus === 429) {
            requireValue(v.status === 'unknown' && v.code === 'rate_limited' && v.httpStatus === 429 && ['latencyMs', 'bytes', 'bytesPerSecond', 'region'].every(key => v[key] === undefined), 'invalid_rate_limit');
        }
        const out = { status: v.status, code: v.code };
        for (const [key, max] of Object.entries({ latencyMs: 180000, bytes: 20 * 1024 * 1024, bytesPerSecond: 1e12, httpStatus: 599 })) {
            if (v[key] !== undefined) {
                requireValue(Number.isFinite(v[key]) && v[key] >= 0 && v[key] <= max, 'invalid_result_metric');
                out[key] = v[key];
            }
        }
        if (v.region !== undefined) {
            requireValue(typeof v.region === 'string' && /^[A-Z]{2}$/.test(v.region), 'invalid_result_region');
            out.region = v.region;
        }
        if (v.retryAfterSeconds !== undefined) {
            requireValue(v.code === 'rate_limited' && v.httpStatus === 429 && Number.isInteger(v.retryAfterSeconds) && v.retryAfterSeconds >= 0 && v.retryAfterSeconds <= 86400, 'invalid_retry_after');
            out.retryAfterSeconds = v.retryAfterSeconds;
        }
        return out;
    };
    const out = {};
    for (const type of types) {
        out[type] = cleanCheck(input[type]);
        if (type === 'unlock' && input[type].services !== undefined) {
            requireValue(Array.isArray(input[type].services) && input[type].services.length <= services.length, 'invalid_service_results');
            const seen = new Set();
            out[type].services = input[type].services.map(v => {
                requireValue(services.includes(v.service) && !seen.has(v.service), 'invalid_service_result');
                seen.add(v.service);
                return { service: v.service, ...cleanCheck(v) };
            });
        }
    }
    return out;
}
