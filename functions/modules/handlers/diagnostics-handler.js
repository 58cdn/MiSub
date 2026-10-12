import { createJsonResponse } from '../utils.js';
import {
    SOURCES,
    selectSources,
    emptyResult,
    validateReport,
} from '../../services/diagnostics/contract.js';
import { readBoundedText } from '../../services/diagnostics/runner.js';

const limits = new WeakMap();
const reply = (data, status = 200, headers = {}) =>
    createJsonResponse(data, status, { 'Cache-Control': 'no-store', ...headers });
const bindingOf = (env) =>
    typeof env?.NODE_DIAGNOSTICS?.fetch === 'function' ? env.NODE_DIAGNOSTICS : null;

export function handleDiagnosticsCapabilities(request, env) {
    if (request.method !== 'GET')
        return reply({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    return reply({
        version: 1,
        executorConfigured: Boolean(bindingOf(env)),
        executor: 'NODE_DIAGNOSTICS',
        sources: SOURCES.map(({ id, kind, label, url }) => ({
            id,
            kind,
            label,
            implemented: Boolean(url),
        })),
        maxNodes: 1,
        cooldownSeconds: 60,
    });
}

// Called only behind the router's admin session check. This path accepts one
// explicitly consented node, never subscriptions or a client-supplied executor URL.
export async function handleNodeDiagnostics(request, env) {
    if (request.method !== 'POST')
        return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (request.headers.get('Origin') !== new URL(request.url).origin)
        return reply({ error: 'origin_required' }, 403);
    let body;
    let sources;
    const inputController = new AbortController();
    let inputTimedOut = false;
    const abortInput = () => inputController.abort();
    request.signal.addEventListener('abort', abortInput, { once: true });
    if (request.signal.aborted) abortInput();
    const inputTimer = setTimeout(() => {
        inputTimedOut = true;
        abortInput();
    }, 5000);
    try {
        body = JSON.parse(await readBoundedText(request, 16384, inputController.signal));
        sources = selectSources(body.sources);
        if (Object.keys(body).some((key) => !['node', 'sources', 'consent'].includes(key)))
            throw new Error();
        if (
            typeof body.node !== 'string' ||
            body.node.length > 8192 ||
            !/^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|socks5?|https?|anytls|snell|mieru):\/\/\S+$/i.test(
                body.node
            )
        )
            throw new Error();
    } catch {
        return reply(
            {
                error: inputTimedOut
                    ? 'timeout'
                    : request.signal.aborted
                      ? 'cancelled'
                      : 'invalid_request',
            },
            inputTimedOut ? 408 : request.signal.aborted ? 499 : 400
        );
    } finally {
        clearTimeout(inputTimer);
        request.signal.removeEventListener('abort', abortInput);
    }
    if (body.consent !== true) return reply({ error: 'consent_required' }, 400);
    const executor = bindingOf(env);
    if (!executor)
        return reply({
            version: 1,
            scope: 'none',
            results: sources.map((source) =>
                emptyResult(source, 'unsupported', 'executor_unavailable')
            ),
            conflicts: [],
        });
    const now = Date.now();
    const previous = limits.get(executor);
    if (previous && (previous.active || previous.nextAt > now))
        return reply({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    const state = { active: true, nextAt: now + 60000 };
    limits.set(executor, state);
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    let timer;
    let rejectStop;
    const stopped = new Promise((_, reject) => {
        rejectStop = reject;
    });
    const stop = (code) => {
        controller.abort();
        rejectStop(new Error(code));
    };
    const onAbort = () => stop('cancelled');
    request.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop('timeout'), 25000);
    try {
        const operation = (async () => {
            if (request.signal.aborted) throw new Error('cancelled');
            // A service binding is an administrator-managed trust boundary. The URL
            // is a fixed internal routing label; fetch() never uses the public network.
            const response = await executor.fetch(
                new Request('https://diagnostics.internal/v1/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    redirect: 'error',
                    signal: controller.signal,
                    body: JSON.stringify({
                        version: 1,
                        requestId,
                        node: body.node,
                        sources: sources.map((s) => s.id),
                    }),
                })
            );
            if (controller.signal.aborted) {
                await response.body?.cancel();
                throw new Error('cancelled');
            }
            if (!response.ok || response.redirected) {
                await response.body?.cancel();
                throw new Error('executor_error');
            }
            return validateReport(
                JSON.parse(await readBoundedText(response, 65536, controller.signal)),
                requestId,
                sources,
                now
            );
        })();
        return reply(await Promise.race([operation, stopped]));
    } catch (error) {
        const code = ['timeout', 'cancelled'].includes(error.message)
            ? error.message
            : 'invalid_executor_response';
        return reply({ error: code }, code === 'timeout' ? 504 : code === 'cancelled' ? 499 : 502);
    } finally {
        state.active = false;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
    }
}
