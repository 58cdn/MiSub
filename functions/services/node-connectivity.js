import { readProbeJson } from './probe-http.js';
import { connectivityError, resolveConnectivityTarget } from './connectivity-target.js';

const MAX_ACTIVE = 3,
    MAX_PER_MINUTE = 60,
    COOLDOWN_MS = 10000,
    DEADLINE_MS = 5000;
const UDP_TYPES = new Set(['hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard']);
const TCP_TYPES = new Set([
    'ss',
    'ssr',
    'vmess',
    'vless',
    'trojan',
    'snell',
    'anytls',
    'http',
    'socks5',
    'mieru',
]);
const reply = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            ...headers,
        },
    });
const failure = (code, status, headers) =>
    reply({ success: false, error: { code } }, status, headers);
const observation = (status, code, latencyMs = null) => ({
    version: 1,
    status,
    code,
    latencyMs,
    measurement: 'worker_tcp_connect',
    vantage: 'cloudflare_worker',
    checkedAt: Date.now(),
});

// Limits are shared by requests to this handler in one Worker isolate. They are
// resource guards, not a deployment-wide quota or a replacement for admin auth.
export function createConnectivityHandler({
    authorizeAdmin,
    loadManualNodes,
    prepareNodes,
    connect,
    resolveTarget = resolveConnectivityTarget,
    now = Date.now,
}) {
    let active = 0,
        windowAt = 0,
        count = 0;
    const cooldowns = new Map();
    return async function handle(request, env) {
        try {
            if (!(await authorizeAdmin(request, env))) return failure('unauthorized', 401);
        } catch {
            return failure('authorization_unavailable', 503);
        }
        const url = new URL(request.url);
        if (request.method !== 'POST') return failure('method_not_allowed', 405, { Allow: 'POST' });
        if (request.headers.get('Origin') !== url.origin) return failure('invalid_origin', 403);
        if (url.search) return failure('invalid_request', 400);
        if (active >= MAX_ACTIVE) return failure('rate_limited', 429, { 'Retry-After': '5' });
        const startedAt = now();
        if (startedAt - windowAt >= 60000) {
            windowAt = startedAt;
            count = 0;
        }
        if (count >= MAX_PER_MINUTE) return failure('rate_limited', 429, { 'Retry-After': '60' });
        active++;
        count++;
        let timer,
            socket,
            stopped = false;
        const controller = new AbortController();
        let rejectStop;
        const stopPromise = new Promise((_, reject) => {
            rejectStop = reject;
        });
        // Observe even if body/storage handling has not yet entered its race.
        stopPromise.catch(() => {});
        const stop = (code) => {
            stopped = true;
            controller.abort();
            rejectStop(Object.assign(new Error(code), { connectivityCode: code }));
        };
        const onAbort = () => stop('cancelled');
        request.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => stop('deadline'), DEADLINE_MS);
        if (request.signal.aborted) onAbort();
        try {
            const input = await Promise.race([readProbeJson(request, 256), stopPromise]);
            if (
                Object.keys(input).length !== 1 ||
                typeof input.nodeId !== 'string' ||
                !/^[\w-]{1,128}$/.test(input.nodeId)
            )
                return failure('invalid_request', 400);
            for (const [key, until] of cooldowns) if (until <= startedAt) cooldowns.delete(key);
            if (cooldowns.has(input.nodeId))
                return failure('rate_limited', 429, { 'Retry-After': '10' });
            cooldowns.set(input.nodeId, startedAt + COOLDOWN_MS);
            let nodes;
            try {
                nodes = await Promise.race([loadManualNodes(env), stopPromise]);
                if (!Array.isArray(nodes)) return failure('storage_unavailable', 503);
            } catch (error) {
                if (controller.signal.aborted) throw error;
                return failure('storage_unavailable', 503);
            }
            const node = nodes.find((item) => item.id === input.nodeId);
            if (!node) return failure('node_not_found', 404);
            const scheme = String(node.url || '')
                .split(':', 1)[0]
                .toLowerCase();
            if (UDP_TYPES.has(scheme))
                return reply({
                    success: true,
                    data: observation('unsupported', 'udp_not_applicable'),
                });
            const [prepared] = await Promise.race([prepareNodes([node]), stopPromise]);
            const proxy = prepared?.proxy;
            if (!proxy)
                return reply({
                    success: true,
                    data: observation('unsupported', 'invalid_or_unsupported_node'),
                });
            if (
                !TCP_TYPES.has(proxy.type) ||
                ['kcp', 'quic', 'udp'].includes(
                    String(proxy.network || proxy.transport || '').toLowerCase()
                )
            )
                return reply({
                    success: true,
                    data: observation('unsupported', 'udp_not_applicable'),
                });
            if (proxy.port === 25)
                return reply({
                    success: true,
                    data: observation('unsupported', 'platform_restricted'),
                });
            // Only host and port cross the network boundary. No proxy handshake,
            // application bytes, URI, password, UUID, or user headers are sent.
            let hostname;
            try {
                hostname = await Promise.race([
                    resolveTarget(proxy.server, controller.signal),
                    stopPromise,
                ]);
            } catch (error) {
                throw error?.connectivityCode ? error : connectivityError('dns_failed');
            }
            if (stopped) throw Object.assign(new Error(), { connectivityCode: 'cancelled' });
            const start = performance.now();
            socket = connect(
                { hostname, port: proxy.port },
                { secureTransport: 'off', allowHalfOpen: false }
            );
            socket.closed.catch(() => {});
            await Promise.race([socket.opened, stopPromise]);
            return reply({
                success: true,
                data: observation(
                    'ok',
                    'port_reachable',
                    Math.max(0, Math.round(performance.now() - start))
                ),
            });
        } catch (error) {
            if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)
                return failure(
                    [
                        'body_too_large',
                        'body_timeout',
                        'json_required',
                        'invalid_json',
                        'request_cancelled',
                    ].includes(error.code)
                        ? error.code
                        : 'invalid_request',
                    error.status
                );
            const code = error?.connectivityCode;
            const known = {
                unsafe_target: 'blocked',
                dns_failed: 'unknown',
                deadline: 'timeout',
                cancelled: 'cancelled',
            };
            if (known[code]) return reply({ success: true, data: observation(known[code], code) });
            // Runtime wording is used only to classify documented restrictions;
            // raw errors can contain targets and never leave this boundary.
            const restricted =
                /proxy request failed, cannot connect to the specified address|TCP Loop detected|Connections to port 25 are prohibited/i.test(
                    String(error?.message || '')
                );
            return reply({
                success: true,
                data: observation(
                    restricted ? 'unsupported' : 'unknown',
                    restricted ? 'platform_restricted' : 'connect_failed'
                ),
            });
        } finally {
            stopped = true;
            clearTimeout(timer);
            controller.abort();
            request.signal.removeEventListener('abort', onAbort);
            // close() forcibly closes both streams; no reader or writer is acquired.
            try {
                if (socket) void Promise.resolve(socket.close()).catch(() => {});
            } catch {
                /* No target data in logs. */
            }
            active--;
        }
    };
}
