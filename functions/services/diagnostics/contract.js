import { isIP } from 'node:net';

export const PROBE_VERSION = '1';
export const SOURCES = Object.freeze(
    [
        {
            id: 'latency',
            kind: 'latency',
            label: 'Node HTTP URLTest',
            url: 'https://www.gstatic.com/generate_204',
        },
        {
            id: 'ipify',
            kind: 'exit',
            label: 'ipify.org',
            url: 'https://api64.ipify.org?format=json',
        },
        { id: 'ip_sb', kind: 'exit', label: 'IP.SB', url: 'https://api.ip.sb/geoip' },
        { id: 'ifconfig', kind: 'exit', label: 'ifconfig.me', url: 'https://ifconfig.me/ip' },
        { id: 'icanhazip', kind: 'exit', label: 'icanhazip.com', url: 'https://icanhazip.com/' },
        { id: 'ipinfo', kind: 'exit', label: 'IPinfo Lite', url: 'https://api.ipinfo.io/lite/me' },
        { id: 'ippure', kind: 'quality', label: 'IPPure', url: 'https://my.ippure.com/v1/info' },
        {
            id: 'openai',
            kind: 'unlock',
            label: 'OpenAI API',
            url: 'https://api.openai.com/v1/models',
        },
        ...['netflix', 'disney', 'youtube', 'gemini', 'claude'].map((id) => ({
            id,
            kind: 'unlock',
            label: id,
        })),
    ].map(Object.freeze)
);

export const STATUSES = new Set([
    'ok',
    'partial',
    'unknown',
    'restricted',
    'unsupported',
    'not_configured',
    'timeout',
    'cancelled',
    'rate_limited',
    'challenge',
    'error',
]);
export const ERRORS = new Set([
    'executor_unavailable',
    'transport_unavailable',
    'checker_not_implemented',
    'token_required',
    'timeout',
    'cancelled',
    'rate_limited',
    'challenge',
    'network_error',
    'http_error',
    'redirect_rejected',
    'response_too_large',
    'invalid_response',
    'no_availability_evidence',
    'unsupported_country',
]);

export function selectSources(ids) {
    if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > SOURCES.length ||
        new Set(ids).size !== ids.length
    )
        throw new Error('invalid_sources');
    const selected = ids.map((id) => SOURCES.find((item) => item.id === id));
    if (selected.some((item) => !item)) throw new Error('invalid_sources');
    return selected;
}

export function emptyResult(source, status, error) {
    return {
        source: source.id,
        kind: source.kind,
        status,
        error,
        checkedAt: new Date().toISOString(),
        durationMs: 0,
        probeVersion: PROBE_VERSION,
        ip: null,
        family: null,
        countryCode: null,
        asn: null,
        riskScore: null,
        isResidential: null,
        isBroadcast: null,
        latencyMs: null,
        measurement: null,
        httpStatus: null,
        retryAfterSeconds: null,
    };
}

export function canonicalIP(value) {
    if (typeof value !== 'string' || !isIP(value.trim())) return null;
    const ip = value.trim();
    return isIP(ip) === 6 ? new URL(`https://[${ip}]/`).hostname.slice(1, -1) : ip;
}

const nullableNumber = (value, max) =>
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max);

// Only typed evidence leaves the executor boundary. Never return raw provider bodies,
// exception messages, node URIs or arbitrary metadata that could contain credentials.
export function validateReport(report, requestId, sources, startedAt) {
    if (
        report?.version !== 1 ||
        report.requestId !== requestId ||
        report.scope !== 'node' ||
        !Array.isArray(report.results) ||
        report.results.length !== sources.length
    )
        throw new Error('invalid_report');
    const now = Date.now();
    const results = sources.map((source) => {
        const matches = report.results.filter((r) => r?.source === source.id);
        if (matches.length !== 1) throw new Error('invalid_report');
        const r = matches[0];
        const checked = Date.parse(r.checkedAt);
        if (
            r.kind !== source.kind ||
            !STATUSES.has(r.status) ||
            (r.error !== null && !ERRORS.has(r.error)) ||
            r.probeVersion !== PROBE_VERSION ||
            typeof r.checkedAt !== 'string' ||
            !Number.isFinite(checked) ||
            checked < startedAt - 1000 ||
            checked > now + 1000 ||
            !nullableNumber(r.durationMs, 30000) ||
            r.durationMs === null
        )
            throw new Error('invalid_report');
        const ip = canonicalIP(r.ip);
        if (r.ip !== null && !ip) throw new Error('invalid_report');
        if (
            r.family !== (ip ? isIP(ip) : null) ||
            (r.countryCode !== null &&
                (typeof r.countryCode !== 'string' || !/^[A-Z]{2}$/.test(r.countryCode))) ||
            (r.asn !== null && (!Number.isSafeInteger(r.asn) || r.asn < 0 || r.asn > 4294967295))
        )
            throw new Error('invalid_report');
        if (
            ![r.isResidential, r.isBroadcast].every((v) => v === null || typeof v === 'boolean') ||
            !nullableNumber(r.riskScore, 100) ||
            !nullableNumber(r.latencyMs, 30000) ||
            !nullableNumber(r.retryAfterSeconds, 86400)
        )
            throw new Error('invalid_report');
        if (
            r.httpStatus !== null &&
            (!Number.isInteger(r.httpStatus) || r.httpStatus < 100 || r.httpStatus > 599)
        )
            throw new Error('invalid_report');
        if (
            source.kind !== 'quality' &&
            [r.riskScore, r.isResidential, r.isBroadcast].some((v) => v !== null)
        )
            throw new Error('invalid_report');
        if (source.kind !== 'latency' && (r.latencyMs !== null || r.measurement !== null))
            throw new Error('invalid_report');
        if (
            source.kind === 'latency' &&
            ((r.status === 'ok' &&
                (r.latencyMs === null || r.measurement !== 'node_http_urltest')) ||
                (r.status !== 'ok' && (r.latencyMs !== null || r.measurement !== null)))
        )
            throw new Error('invalid_report');
        if (
            ['exit', 'quality'].includes(source.kind) &&
            ['ok', 'partial'].includes(r.status) &&
            !ip
        )
            throw new Error('invalid_report');
        // V1 does not infer successful unlock from ordinary HTTP reachability.
        if (source.kind === 'unlock' && ['ok', 'partial'].includes(r.status))
            throw new Error('invalid_report');
        const hasData = ['ok', 'partial'].includes(r.status);
        if (hasData && r.error !== null) throw new Error('invalid_report');
        if (
            !hasData &&
            [r.ip, r.countryCode, r.asn, r.riskScore, r.isResidential, r.isBroadcast].some(
                (v) => v !== null
            )
        )
            throw new Error('invalid_report');
        if (
            source.kind === 'quality' &&
            r.status === 'ok' &&
            [r.riskScore, r.isResidential, r.isBroadcast].some((v) => v === null)
        )
            throw new Error('invalid_report');
        if (
            r.status === 'restricted' &&
            (source.id !== 'openai' || r.error !== 'unsupported_country' || r.httpStatus !== 403)
        )
            throw new Error('invalid_report');
        if (!source.url && (r.status !== 'unsupported' || r.error !== 'checker_not_implemented'))
            throw new Error('invalid_report');
        const clean = emptyResult(source, r.status, r.error);
        for (const key of Object.keys(clean)) clean[key] = r[key];
        clean.ip = ip;
        clean.checkedAt = new Date(checked).toISOString();
        return clean;
    });
    // IPv4 and IPv6 may legitimately differ. Flag conflicts only within each family,
    // and keep country disagreements tied to the exact IP rather than majority voting.
    const conflicts = [];
    for (const family of [4, 6]) {
        const relevant = results.filter(
            (r) => r.family === family && ['ok', 'partial'].includes(r.status)
        );
        const ips = [...new Set(relevant.map((r) => r.ip))];
        if (ips.length > 1) conflicts.push({ type: 'ip', family, values: ips });
        for (const ip of ips) {
            const countries = [
                ...new Set(
                    relevant
                        .filter((r) => r.ip === ip)
                        .map((r) => r.countryCode)
                        .filter(Boolean)
                ),
            ];
            if (countries.length > 1) conflicts.push({ type: 'country', ip, values: countries });
        }
    }
    return {
        version: 1,
        requestId,
        scope: 'node',
        checkedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600000).toISOString(),
        results,
        conflicts,
    };
}
