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
        // 节点可携带转换器使用的协议参数；路径或其它查询参数仍按订阅源处理。
        return Boolean(
            parsed.username &&
            parsed.password &&
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
    const url = item.url.trim();
    return NODE_PROTOCOL_REGEX.test(url) || isHttpProxyUrl(url);
}

export function isRemoteSubscription(item) {
    return (
        typeof item?.url === 'string' &&
        /^https?:\/\//i.test(item.url.trim()) &&
        !isHttpProxyUrl(item.url)
    );
}
