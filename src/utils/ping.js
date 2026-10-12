import { t } from '@/i18n/index.js';

const STATES = new Set(['ok', 'unknown', 'timeout', 'cancelled', 'unsupported', 'blocked']);
const CODES = new Set([
    'port_reachable',
    'connect_failed',
    'deadline',
    'cancelled',
    'udp_not_applicable',
    'invalid_or_unsupported_node',
    'platform_restricted',
    'unsafe_target',
    'dns_failed',
]);
const STATUS_BY_CODE = {
    port_reachable: 'ok',
    connect_failed: 'unknown',
    deadline: 'timeout',
    cancelled: 'cancelled',
    udp_not_applicable: 'unsupported',
    invalid_or_unsupported_node: 'unsupported',
    platform_restricted: 'unsupported',
    unsafe_target: 'blocked',
    dns_failed: 'unknown',
};
export function connectivityMessage(result) {
    const key =
        {
            port_reachable: 'latencyHint',
            connect_failed: 'connectivityFailed',
            deadline: 'connectivityTimeout',
            cancelled: 'connectivityCancelled',
            udp_not_applicable: 'connectivityUdp',
            invalid_or_unsupported_node: 'connectivityInvalid',
            platform_restricted: 'connectivityRestricted',
            unsafe_target: 'connectivityBlocked',
            dns_failed: 'connectivityDns',
            rate_limited: 'connectivityRateLimited',
            node_not_found: 'connectivitySaveFirst',
            unsaved_node: 'connectivitySaveFirst',
            unauthorized: 'connectivityLogin',
        }[result?.code] || 'connectivityUnavailable';
    return t(`manualNodes.${key}`);
}

// This request carries an existing ID only. It never contacts a node from the browser.
export async function pingNode(nodeId) {
    if (typeof nodeId !== 'string' || !/^[\w-]{1,128}$/.test(nodeId))
        return { status: 'unknown', code: 'unsaved_node', latency: -1 };
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({ status: 'unknown', code: 'request_timeout', latency: -1 });
        }, 8000);
    });
    try {
        const operation = (async () => {
            const response = await fetch('/api/nodes/connectivity', {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'error',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nodeId }),
            });
            const body = await response.json();
            if (!response.ok || body.success !== true) {
                const code = ['rate_limited', 'node_not_found', 'unauthorized'].includes(
                    body.error?.code
                )
                    ? body.error.code
                    : 'request_failed';
                return { status: 'unknown', code, latency: -1 };
            }
            const value = body.data;
            if (
                !value ||
                !STATES.has(value.status) ||
                !CODES.has(value.code) ||
                value.status !== STATUS_BY_CODE[value.code] ||
                value.version !== 1 ||
                value.measurement !== 'worker_tcp_connect' ||
                value.vantage !== 'cloudflare_worker' ||
                !Number.isSafeInteger(value.checkedAt) ||
                value.checkedAt < 0 ||
                (value.status === 'ok'
                    ? value.code !== 'port_reachable' ||
                      !Number.isInteger(value.latencyMs) ||
                      value.latencyMs < 0 ||
                      value.latencyMs > 5000
                    : value.latencyMs !== null)
            )
                return { status: 'unknown', code: 'invalid_response', latency: -1 };
            return {
                status: value.status,
                code: value.code,
                latency: value.latencyMs ?? -1,
                measurement: value.measurement,
                vantage: value.vantage,
                checkedAt: value.checkedAt,
            };
        })().catch(() => ({ status: 'unknown', code: 'request_failed', latency: -1 }));
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
