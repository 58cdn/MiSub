import { digest, requireValue, MAX_NODES } from './probe-contract.js';
const TYPES = new Set(['ss','ssr','vmess','vless','trojan','hysteria','hysteria2','tuic','snell','wireguard','anytls','http','https','socks5','socks5-tls','mieru']);
// Reject credential-bearing JSON/URI parse errors before the shared converter can log them.
function preflightUri(uri) {
    decodeURIComponent(uri);
    const scheme = uri.slice(0, uri.indexOf(':')).toLowerCase();
    if (!['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'snell', 'wireguard', 'anytls', 'http', 'https', 'socks5', 'mierus'].includes(scheme)) return false;
    if (scheme === 'vmess') {
        const encoded = uri.slice(8).split('#')[0].split('?')[0].replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_format');
    }
    const query = uri.split('?')[1]?.split('#')[0];
    const extra = query ? new URLSearchParams(query).get('extra') : null;
    if (extra) JSON.parse(extra);
    return true;
}
/** The converter is the same one used by MiSub subscription generation. */
export function createProbeNodePreparer(convert) {
    return async function prepareNodes(nodes) {
        requireValue(Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX_NODES, 'invalid_node_count');
        const seen = new Set();
        const prepared = [];
        for (const node of nodes) {
            requireValue(node && typeof node.url === 'string' && node.url.length > 0 && node.url.length <= 16384 && !/[\r\n\x00]/.test(node.url), 'invalid_node_url');
            const id = node.id === undefined ? `n_${(await digest(node.url)).slice(0,24)}` : String(node.id);
            requireValue(id.length > 0 && id.length <= 128 && !/[\x00-\x1f\x7f]/.test(id) && !seen.has(id), 'invalid_node_id');
            seen.add(id);
            let proxy = null;
            let format = { status: 'failed', code: 'invalid_format' };
            try {
                if (preflightUri(node.url.trim())) proxy = convert(node.url.trim());
                else format = { status: 'unsupported', code: 'unsupported_protocol' };
            } catch { /* Never log the URI or parser exception. */ }
            if (proxy && TYPES.has(proxy.type) && typeof proxy.server === 'string' && proxy.server.length > 0 && proxy.server.length <= 253 && Number.isInteger(Number(proxy.port)) && Number(proxy.port) > 0 && Number(proxy.port) <= 65535) {
                const p = { ...proxy, name: 'probe-target', port: Number(proxy.port) };
                delete p.metadata;
                const needsPassword = ['ss','ssr','trojan','hysteria2','tuic','snell','anytls'].includes(p.type);
                const needsUuid = ['vmess','vless','tuic'].includes(p.type);
                const valid = (!needsPassword || (typeof p.password === 'string' && p.password.length > 0)) && (!needsUuid || (typeof p.uuid === 'string' && p.uuid.length > 0)) && (!['ss','ssr'].includes(p.type) || typeof p.cipher === 'string');
                if (valid) {
                    // Do not silently remove a routing dependency or secondary destination and then claim to have tested the original node.
                    const unsupported = p['dialer-proxy'] || p['interface-name'] || p['routing-mark'] || p.peers || p['xhttp-opts']?.extra;
                    format = { status: unsupported ? 'unsupported' : 'passed', code: unsupported ? 'unsupported_transport' : 'ok' };
                    if (p.type === 'https') { p.type = 'http'; p.tls = true; }
                    if (p.type === 'socks5-tls') { p.type = 'socks5'; p.tls = true; }
                    proxy = unsupported ? null : p;
                } else { proxy = null; }
            } else { proxy = null; }
            const name = String(node.name || id).replace(/[\x00-\x1f\x7f]/g,'').slice(0,200);
            prepared.push({ id, name, proxy, format });
        }
        return prepared;
    };
}
