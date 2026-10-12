import { selectSources, validateReport } from './diagnostics/contract.js';

export const OBSERVATIONS_VERSION = 1;
export const OBSERVATION_SOURCES = ['ipify', 'ip_sb', 'ifconfig', 'icanhazip', 'ipinfo', 'ippure'];
export const DEFAULT_OBSERVATION_SOURCES = ['ipify', 'ip_sb', 'ifconfig', 'icanhazip'];

export function sanitizeObservations(report, options, context) {
    if (options.observationsVersion !== OBSERVATIONS_VERSION || !context?.taskId || !Array.isArray(options.sources) || !options.sources.length || options.sources.some(id => !OBSERVATION_SOURCES.includes(id))) throw new Error('invalid_observations');
    if (!Number.isFinite(context.startedAt) || !Number.isFinite(context.now)) throw new Error('invalid_observations');
    // Native execution has a three-minute ceiling. Queued job age is not fresh
    // evidence: require recently completed source observations on this delivery.
    const clean = validateReport(report, context.taskId, selectSources(options.sources), Math.max(context.startedAt, context.now - 180000), context.now);
    for (const r of clean.results) {
        const success = ['ok', 'partial'].includes(r.status);
        if (success && !(r.httpStatus >= 200 && r.httpStatus < 300)) throw new Error('invalid_observations');
        if (r.httpStatus === 429 && r.status !== 'rate_limited') throw new Error('invalid_observations');
        if (r.retryAfterSeconds !== null && (r.status !== 'rate_limited' || !Number.isInteger(r.retryAfterSeconds))) throw new Error('invalid_observations');
        if (r.status === 'rate_limited' && (r.error !== 'rate_limited' || ![null, 429].includes(r.httpStatus))) throw new Error('invalid_observations');
        if (r.status === 'challenge' && r.error !== 'challenge') throw new Error('invalid_observations');
        if (['timeout', 'cancelled'].includes(r.status) && r.error !== r.status) throw new Error('invalid_observations');
        if (r.source === 'ipinfo' && !(r.status === 'not_configured' && r.error === 'token_required') && !['unsupported', 'cancelled'].includes(r.status)) throw new Error('invalid_observations');
    }
    // Display freshness follows the oldest included observation, not delivery
    // time. Replaying or delaying a result cannot make old evidence look new.
    const observedAt = Math.min(...clean.results.map(r => Date.parse(r.checkedAt)));
    clean.checkedAt = new Date(observedAt).toISOString();
    clean.expiresAt = new Date(observedAt + 600000).toISOString();
    return clean;
}
