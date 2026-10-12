export const PROBE_TYPES = ['format', 'tcp', 'proxy', 'speed', 'unlock', 'observations'];
export const PROBE_SERVICES = [
    'netflix',
    'youtube',
    'openai',
    'claude',
    'gemini',
    'disney',
    'spotify',
    'tiktok',
];
export const PROBE_SOURCES = [
    { id: 'ipify', label: 'ipify.org' },
    { id: 'ip_sb', label: 'IP.SB' },
    { id: 'ifconfig', label: 'ifconfig.me' },
    { id: 'icanhazip', label: 'icanhazip.com' },
    { id: 'ipinfo', label: 'IPinfo', unavailable: true },
    { id: 'ippure', label: 'IPPure', experimental: true },
];
export const DEFAULT_PROBE_SOURCES = ['ipify', 'ip_sb', 'ifconfig', 'icanhazip'];
const MAX_BATCH_BYTES = 768 * 1024;
export function selectedProbeNodes(nodes, selectedIds, scope) {
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
    if (!['all', 'selected'].includes(scope)) throw new Error('invalid_scope');
    const result = scope === 'all' ? nodes : nodes.filter((n) => selected.has(n.id));
    if (scope === 'selected' && result.length !== selected.size)
        throw new Error('selection_changed');
    if (!result.length) throw new Error('no_nodes');
    if (new Set(result.map((n) => n.id)).size !== result.length) throw new Error('duplicate_nodes');
    return result.map((n) => ({ id: String(n.id), name: String(n.name || n.id), url: n.url }));
}
export function makeProbePlan(nodes, types, agentIds, options) {
    if (!Array.isArray(types) || !types.length || types.some((t) => !PROBE_TYPES.includes(t)))
        throw new Error('invalid_types');
    const network = types.some((t) => t !== 'format');
    if (network && (!agentIds.length || agentIds.length > 8)) throw new Error('select_detectors');
    const agents = network ? [...new Set(agentIds)] : [];
    if (
        types.includes('observations') &&
        (options.observationsVersion !== 1 ||
            !Array.isArray(options.sources) ||
            !options.sources.length ||
            options.sources.length > PROBE_SOURCES.length ||
            new Set(options.sources).size !== options.sources.length ||
            options.sources.some((id) => !PROBE_SOURCES.some((s) => s.id === id && !s.unavailable)))
    )
        throw new Error('invalid_sources');
    const budget = types.includes('speed')
        ? nodes.length * agents.length * options.downloadBytes * 3
        : 0;
    if (budget > 1024 ** 3) throw new Error('job_traffic_limit');
    const chunks = [];
    let chunk = [];
    const body = (list) => ({
        scope: 'snapshot',
        nodes: list,
        types: [...types],
        agentIds: agents,
        consent: network,
        options: { ...options },
    });
    const size = (list) => new TextEncoder().encode(JSON.stringify(body(list))).length;
    for (const node of nodes) {
        if (typeof node.url !== 'string' || !node.url || node.url.length > 16384)
            throw new Error('invalid_node_url');
        if (chunk.length && (chunk.length >= 500 || size([...chunk, node]) > MAX_BATCH_BYTES)) {
            chunks.push(body(chunk));
            chunk = [];
        }
        chunk.push(node);
        if (size(chunk) > MAX_BATCH_BYTES) throw new Error('body_too_large');
    }
    if (chunk.length) chunks.push(body(chunk));
    if (!chunks.length || chunks.length > 20) throw new Error('batch_limit');
    return { network, budget, chunks };
}
export async function probeRequest(path, { method = 'GET', body, key, signal } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(onAbort, 20000);
    try {
        const response = await fetch(`/api/probes/v1/${path}`, {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(key ? { 'Idempotency-Key': key } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok || data.success !== true) {
            const code = String(data.error?.code || 'request_failed');
            const error = new Error(/^[a-z_]{1,60}$/.test(code) ? code : 'request_failed');
            const retryAfter = data.error?.retryAfterSeconds;
            if (Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 86400) {
                error.retryAfterSeconds = retryAfter;
            }
            throw error;
        }
        return data.data;
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error('request_cancelled_or_timeout');
        if (/^[a-z_]{1,60}$/.test(e?.message || '')) throw e;
        throw new Error('request_failed');
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
export function probeBytes(value) {
    return `${(Number(value || 0) / 1024 / 1024).toFixed(2)} MiB`;
}
