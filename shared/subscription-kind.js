const NODE_PROTOCOL_REGEX =
    /^(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy|hy2|tuic|anytls|socks5|socks|snell|naive\+https|naive\+quic|naive\+http|wireguard):\/\//i;
const HTTP_PROXY_QUERY_KEYS = new Set(['sni', 'peer', 'allowInsecure', 'insecure', 'fp', 'alpn']);

export function isHttpProxyUrl(value) {
    if (typeof value !== 'string') return false;
    const url = value.trim();
    const authority = url.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (!authority || !/:\d+$/.test(authority)) return false;
    try {
        const parsed = new URL(url);
        // 显式手动 HTTP 节点使用根路径，并可携带转换器支持的协议参数。
        return Boolean(
            parsed.hostname &&
            parsed.pathname === '/' &&
            [...parsed.searchParams.keys()].every((key) => HTTP_PROXY_QUERY_KEYS.has(key))
        );
    } catch {
        return false;
    }
}

export function isManualNode(item) {
    if (typeof item?.url !== 'string') return false;
    if (item.type === 'subscription') return false;
    const url = item.url.trim();
    return NODE_PROTOCOL_REGEX.test(url) || (item.type === 'manual_node' && isHttpProxyUrl(url));
}

export function isRemoteSubscription(item) {
    return (
        typeof item?.url === 'string' &&
        item.type !== 'manual_node' &&
        /^https?:\/\//i.test(item.url.trim())
    );
}
