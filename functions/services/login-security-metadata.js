export function normalizeLoginIp(value) {
    if (typeof value !== 'string' || value.length > 45) return null;
    if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) {
        return value.split('.').every((part) => Number(part) <= 255) ? value : null;
    }
    if (!value.includes(':') || !/^[\da-f:.]+$/i.test(value)) return null;
    try {
        const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
        const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
        if (mapped) {
            const high = parseInt(mapped[1], 16);
            const low = parseInt(mapped[2], 16);
            return [high >> 8, high & 255, low >> 8, low & 255].join('.');
        }
        return canonical;
    } catch {
        return null;
    }
}

export function trustedLoginIp(request) {
    // request.cf is platform metadata, not a client header. Worker subrequests can
    // alter same-zone CF-Connecting-IP, so this login entry supports direct edge traffic.
    if (!request.cf || typeof request.cf !== 'object' || request.headers.has('CF-Worker')) {
        return null;
    }
    const ip = normalizeLoginIp(request.headers.get('CF-Connecting-IP'));
    if (!ip) return null;
    if (!ip.includes(':') && Number(ip.split('.')[0]) >= 240) {
        const ipv6 = normalizeLoginIp(request.headers.get('CF-Connecting-IPv6'));
        return ipv6?.includes(':') ? ipv6 : null;
    }
    return ip;
}

export function loginDevice(request) {
    const ua = (request.headers.get('User-Agent') || '').slice(0, 1024);
    const browser = /Edg(?:e|A|iOS)?\//i.test(ua)
        ? 'Edge'
        : /(?:OPR|Opera)\//i.test(ua)
          ? 'Opera'
          : /(?:Firefox|FxiOS)\//i.test(ua)
            ? 'Firefox'
            : /(?:Chrome|CriOS)\//i.test(ua)
              ? 'Chrome'
              : /Safari\//i.test(ua)
                ? 'Safari'
                : 'Unknown';
    const os = /(?:iPhone|iPad|iPod)/i.test(ua)
        ? 'iOS'
        : /Android/i.test(ua)
          ? 'Android'
          : /Windows/i.test(ua)
            ? 'Windows'
            : /CrOS/i.test(ua)
              ? 'ChromeOS'
              : /Macintosh|Mac OS X/i.test(ua)
                ? 'macOS'
                : /Linux/i.test(ua)
                  ? 'Linux'
                  : 'Unknown';
    const device =
        /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
            ? 'tablet'
            : /Mobile|iPhone|iPod/i.test(ua)
              ? 'mobile'
              : os !== 'Unknown'
                ? 'desktop'
                : 'unknown';
    return { browser, os, device };
}
