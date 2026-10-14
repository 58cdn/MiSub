import { ProbeStore, PROBE_HISTORY_STATES } from './probe-store.js';
import { ProbePairingStore } from './probe-pairing-store.js';
import { agentManagementQuery, agentActionConfirmation } from './probe-agent-management.js';
import { PAIRING_BODY_BYTES, pairingBody } from './probe-pairing.js';
import { OBSERVATIONS_VERSION, OBSERVATION_SOURCES } from './probe-observations.js';
import { PROBE_TYPES, PROBE_SERVICES, MAX_NODES, MAX_AGENTS, MAX_ATTEMPTS, MAX_JOB_BYTES, normalizeOptions, probeError, requireValue } from './probe-contract.js';
import probeReleaseCatalog from '../../detector/release-catalog.json' with { type: 'json' };
import { probeInstallationCapabilities } from '../../src/shared/probe-release.js';
const PREFIX = '/api/probes/v1';
const LIMIT = 1024 * 1024;
export async function readProbeJson(request, limit = LIMIT) {
    requireValue((request.headers.get('content-type') || '').split(';')[0].trim() === 'application/json', 'json_required', 415);
    const declared = request.headers.get('content-length');
    if (declared) requireValue(/^\d+$/.test(declared) && Number(declared) <= limit, 'body_too_large', 413);
    const reader = request.body?.getReader();
    requireValue(reader, 'invalid_json');
    const parts = []; let size = 0; let timedOut = false;
    const stop = () => { void reader.cancel().catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 5000);
    request.signal.addEventListener('abort', stop, { once: true });
    if (request.signal.aborted) stop();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); throw probeError('body_too_large', 413); }
            parts.push(value);
        }
        if (timedOut) throw probeError('body_timeout', 408);
        if (request.signal.aborted) throw probeError('request_cancelled', 400);
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        let body;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw probeError('invalid_json'); }
        requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_json');
        return body;
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', stop); reader.releaseLock(); }
}
function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers } });
}
function managementPage(searchParams) {
    const read = (name, fallback, min, max) => {
        const values = searchParams.getAll(name);
        if (!values.length) return fallback;
        requireValue(values.length === 1 && /^(0|[1-9]\d{0,5})$/.test(values[0]), `invalid_${name}`);
        const value = Number(values[0]);
        requireValue(value >= min && value <= max, `invalid_${name}`);
        return value;
    };
    return { offset: read('offset', 0, 0, 100000), limit: read('limit', 20, 1, 50) };
}
/** Explicit dependencies make the HTTP/auth boundary testable without a Cloudflare runtime. */
export function createProbeHandler({ authorizeAdmin, prepareNodes, loadManualNodes, makeStore = env => new ProbeStore(env.MISUB_PROBE_DB, Date.now, { runtimeMode: env.PROBE_AGENT_RUNTIME_MODE }) }) {
    async function resolveNodes(input, env) {
        if (input.scope === 'snapshot') return prepareNodes(input.nodes);
        requireValue(input.scope === 'selected' || input.scope === 'all', 'invalid_scope');
        const all = await loadManualNodes(env);
        if (input.scope === 'all') return prepareNodes(all);
        requireValue(Array.isArray(input.nodeIds) && input.nodeIds.length > 0 && input.nodeIds.length <= MAX_NODES && input.nodeIds.every(x=>typeof x==='string'), 'invalid_node_ids');
        const wanted = new Set(input.nodeIds);
        const nodes = all.filter(n => wanted.has(n.id));
        requireValue(nodes.length === wanted.size, 'node_not_found', 404);
        return prepareNodes(nodes);
    }
    return async function handle(request, env) {
        try {
            const url = new URL(request.url);
            if (!url.pathname.startsWith(`${PREFIX}/`)) throw probeError('not_found', 404);
            const path = url.pathname.slice(PREFIX.length + 1).split('/');
            const method = request.method;
            let store;
            if (path[0] === 'device-pairing') {
                requireValue(!['cookie', 'origin', 'authorization'].some(header => request.headers.has(header)), 'pairing_native_request_required', 403);
                requireValue(method === 'POST' && path.length === 2 && ['start', 'token'].includes(path[1]), 'not_found', 404);
                requireValue(url.protocol === 'https:' && !url.search, 'invalid_pairing_request');
                const body = await readProbeJson(request, PAIRING_BODY_BYTES);
                store = makeStore(env);
                const pairing = new ProbePairingStore(store.db, store.now);
                const data = path[1] === 'start' ? await pairing.start(body, url.origin) : await pairing.token(body, url.origin);
                return json({ success: true, data }, path[1] === 'start' ? 201 : data.status === 'pending' ? 202 : 200);
            }
            if (path[0] === 'agent') {
                requireValue(method === 'POST', 'method_not_allowed', 405);
                requireValue(!request.headers.has('cookie') && !request.headers.has('origin'), 'agent_browser_request_forbidden', 403);
                const auth = request.headers.get('authorization') || '';
                requireValue(/^Bearer mp1_[0-9a-f]{64}$/.test(auth), 'unauthorized', 401);
                // Enrollment initializes the schema; unauthenticated agents must not issue DDL.
                store = makeStore(env);
                const agent = await store.authenticate(auth.slice(7), url.origin);
                const body = await readProbeJson(request);
                if (path.length === 2 && path[1] === 'claim') return json({ success: true, data: await store.claim(agent, body) });
                requireValue(path.length === 4 && path[1] === 'tasks' && /^[\w-]{1,128}$/.test(path[2]), 'not_found', 404);
                if (path[3] === 'heartbeat') return json({ success: true, data: await store.heartbeat(agent, path[2], body.leaseToken) });
                if (path[3] === 'result') return json({ success: true, data: await store.finish(agent, path[2], body.leaseToken, body.checks, body.executionMetadata) });
                throw probeError('not_found', 404);
            }
            requireValue(await authorizeAdmin(request, env), 'unauthorized', 401);
            if (!['GET','HEAD'].includes(method)) requireValue(request.headers.get('origin') === url.origin, 'invalid_origin', 403);
            if (path[0] === 'pairings') {
                requireValue(url.protocol === 'https:' && !url.search, 'invalid_pairing_request');
                store = await makeStore(env).init();
                const pairing = new ProbePairingStore(store.db, store.now);
                if (path.length === 2 && path[1] === 'windows' && method === 'POST') {
                    pairingBody(await readProbeJson(request, PAIRING_BODY_BYTES), []);
                    return json({ success: true, data: await pairing.createWindow(url.origin) }, 201);
                }
                if (path.length === 3 && path[1] === 'windows' && method === 'GET') return json({ success: true, data: await pairing.window(path[2], url.origin) });
                if (path.length === 4 && path[1] === 'windows' && path[3] === 'cancel' && method === 'POST') {
                    pairingBody(await readProbeJson(request, PAIRING_BODY_BYTES), []);
                    return json({ success: true, data: await pairing.cancelWindow(path[2], url.origin) });
                }
                if (path.length === 2 && path[1] === 'resolve' && method === 'POST') {
                    const body = pairingBody(await readProbeJson(request, PAIRING_BODY_BYTES), ['windowId', 'userCode']);
                    return json({ success: true, data: await pairing.resolve(body.windowId, body.userCode, url.origin) });
                }
                if (path.length === 3 && path[1] === 'requests' && method === 'GET') return json({ success: true, data: await pairing.request(path[2], url.origin) });
                if (path.length === 4 && path[1] === 'requests' && path[3] === 'approve' && method === 'POST') {
                    const body = pairingBody(await readProbeJson(request, PAIRING_BODY_BYTES), ['userCode', 'confirmed']);
                    return json({ success: true, data: await pairing.approve(path[2], body.userCode, body.confirmed, url.origin) });
                }
                throw probeError('not_found', 404);
            }
            if (path.length === 1 && path[0] === 'capabilities' && method === 'GET') return json({ success: true, data: { version: 1, types: PROBE_TYPES, services: PROBE_SERVICES, observationsVersion: OBSERVATIONS_VERSION, sources: OBSERVATION_SOURCES, storageReady: Boolean(env.MISUB_PROBE_DB), installation: probeInstallationCapabilities(probeReleaseCatalog), maxNodes: MAX_NODES, maxAgents: MAX_AGENTS, maxAttempts: MAX_ATTEMPTS, maxJobDownloadBytes: MAX_JOB_BYTES } });
            if (path.length === 1 && path[0] === 'format' && method === 'POST') {
                const nodes = await resolveNodes(await readProbeJson(request), env);
                return json({ success: true, data: { checkedAt: Date.now(), nodes: nodes.map(n=>({id:n.id,name:n.name,checks:{format:n.format}})) } });
            }
            store = await makeStore(env).init();
            if (path[0] === 'agents') {
                if (path.length === 2 && path[1] === 'overview' && method === 'GET') {
                    const { offset, limit } = managementPage(url.searchParams);
                    return json({ success: true, data: await store.agentsOverview(offset, limit, agentManagementQuery(url.searchParams)) });
                }
                if (path.length === 3 && ['archive', 'restore'].includes(path[2]) && method === 'POST') {
                    requireValue(/^[\w-]{1,128}$/.test(path[1]) && !url.search, 'invalid_query');
                    agentActionConfirmation(await readProbeJson(request, 256));
                    return json({ success: true, data: await store.archiveAgent(path[1], path[2] === 'archive') });
                }
                if (path.length === 3 && path[2] === 'history' && method === 'GET') {
                    requireValue(/^[\w-]{1,128}$/.test(path[1]), 'not_found', 404);
                    const { offset, limit } = managementPage(url.searchParams);
                    const states = url.searchParams.getAll('state');
                    requireValue(states.length === 0 || (states.length === 1 && PROBE_HISTORY_STATES.includes(states[0])), 'invalid_state');
                    return json({ success: true, data: await store.agentHistory(path[1], offset, limit, states[0] ?? null) });
                }
                if (path.length === 1 && method === 'GET') return json({ success: true, data: await store.agents() });
                if (path.length === 1 && method === 'POST') return json({ success: true, data: await store.addAgent((await readProbeJson(request)).name) }, 201);
                if (path.length === 2 && method === 'DELETE') return json({ success: true, data: { revoked: await store.revokeAgent(path[1]) } });
            }
            if (path[0] === 'jobs') {
                if (path.length === 1 && method === 'GET') return json({ success: true, data: await store.jobs() });
                if (path.length === 1 && method === 'POST') {
                    const body = await readProbeJson(request);
                    requireValue(Array.isArray(body.agentIds) && body.agentIds.length > 0 && body.agentIds.length <= MAX_AGENTS && body.agentIds.every(x=>typeof x==='string' && /^[\w-]{1,128}$/.test(x)), 'invalid_agents');
                    const agentIds = [...new Set(body.agentIds)];
                    const nodes = await resolveNodes(body, env);
                    const normalized = normalizeOptions(body, nodes.length, agentIds.length);
                    requireValue(body.consent === true, 'consent_required');
                    return json({ success: true, data: await store.createJob({ nodes, agentIds, ...normalized }, request.headers.get('Idempotency-Key')) }, 202);
                }
                if (path.length === 2 && method === 'GET') {
                    const offset = Number(url.searchParams.get('offset') || 0);
                    requireValue(Number.isInteger(offset) && offset >= 0 && offset <= MAX_NODES * MAX_AGENTS, 'invalid_offset');
                    return json({ success: true, data: await store.results(path[1], offset) });
                }
                if (path.length === 3 && path[2] === 'cancel' && method === 'POST') {
                    await store.cancel(path[1]); return json({ success: true, data: { cancelled: true } });
                }
            }
            throw probeError('not_found', 404);
        } catch (error) {
            const trusted = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
            const code = trusted ? error.code : 'probe_unavailable';
            const retry = trusted && error.status === 429 && Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 3600 ? error.retryAfterSeconds : null;
            return json({ success: false, error: { code, ...(retry === null ? {} : { retryAfterSeconds: retry }) } }, trusted ? error.status : 503, retry === null ? {} : { 'Retry-After': String(retry) });
        }
    };
}
