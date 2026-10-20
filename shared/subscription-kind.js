const NODE_PROTOCOL_REGEX =
    /^(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy|hy2|tuic|anytls|socks5|socks|snell|naive\+https|naive\+quic|naive\+http|wireguard):\/\//i;

export function isHttpProxyUrl(value) {
    if (typeof value !== 'string') return false;
    const url = value.trim();
    const authority = url.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (!authority || !/:\d+$/.test(authority)) return false;
    try {
        const parsed = new URL(url);
        // 带路径或查询的认证 URL 仍是订阅源；显式默认端口也属于节点端口。
        return Boolean(
            parsed.username &&
            parsed.password &&
            parsed.hostname &&
            parsed.pathname === '/' &&
            !parsed.search
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
