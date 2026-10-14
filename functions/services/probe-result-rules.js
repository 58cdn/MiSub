/** Check variants emitted by the supported native detectors and format parser. */
const preflight = {
    failed: ['invalid_format', 'dns_failed'],
    blocked: ['unsafe_target'],
    unsupported: ['unsupported_protocol', 'unsupported_transport'],
    skipped: ['prerequisite_failed'],
};
const kernel = [
    'unsupported_protocol',
    'unsupported_transport',
    'kernel_missing',
    'kernel_failed',
    'cancelled',
];
export const RESULT_STATES = {
    format: {
        passed: ['ok'],
        failed: ['invalid_format'],
        unsupported: ['unsupported_protocol', 'unsupported_transport'],
    },
    tcp: {
        ...preflight,
        passed: ['ok'],
        failed: [...preflight.failed, 'connect_failed'],
        timeout: ['deadline'],
        cancelled: ['cancelled'],
    },
    proxy: {
        ...preflight,
        unsupported: kernel,
        passed: ['ok'],
        failed: [...preflight.failed, 'request_failed', 'http_error'],
        timeout: ['deadline'],
        cancelled: ['cancelled'],
        unknown: ['rate_limited'],
    },
    speed: {
        ...preflight,
        unsupported: kernel,
        passed: ['ok'],
        failed: [...preflight.failed, 'request_failed', 'http_error'],
        timeout: ['deadline'],
        cancelled: ['cancelled'],
        unknown: ['probe_inconclusive', 'rate_limited'],
    },
    unlock: {
        ...preflight,
        unsupported: kernel,
        unknown: ['probe_inconclusive'],
        cancelled: ['cancelled'],
    },
    service: {
        unknown: ['probe_inconclusive', 'service_reachable', 'rate_limited'],
        blocked: ['region_blocked'],
        failed: ['request_failed'],
        timeout: ['deadline'],
        cancelled: ['cancelled'],
        unsupported: ['probe_inconclusive'],
    },
};

export const RESULT_METRICS = [
    'latencyMs',
    'bytes',
    'bytesPerSecond',
    'httpStatus',
    'retryAfterSeconds',
    'region',
];

export function resultMetrics(type, status, code) {
    if (type === 'service')
        return [
            'probe_inconclusive',
            'service_reachable',
            'region_blocked',
            'rate_limited',
        ].includes(code) && status !== 'unsupported'
            ? code === 'rate_limited'
                ? ['httpStatus', 'retryAfterSeconds']
                : ['httpStatus']
            : [];
    if (code === 'rate_limited' && ['proxy', 'speed'].includes(type))
        return ['httpStatus', 'retryAfterSeconds'];
    if (
        type === 'tcp' &&
        ['ok', 'connect_failed', 'deadline', 'cancelled'].includes(code) &&
        status !== 'unsupported'
    )
        return ['latencyMs'];
    if (type === 'proxy' && status !== 'unsupported') {
        if (['ok', 'http_error'].includes(code)) return ['latencyMs', 'httpStatus'];
        if (['request_failed', 'deadline', 'cancelled'].includes(code)) return ['latencyMs'];
    }
    if (type === 'speed' && status !== 'unsupported') {
        if (code === 'http_error') return ['httpStatus'];
        if (['ok', 'request_failed', 'deadline', 'cancelled', 'probe_inconclusive'].includes(code))
            return ['latencyMs', 'bytes', 'bytesPerSecond', 'httpStatus'];
    }
    return [];
}
