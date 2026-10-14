import { LoginSecurityStore } from './login-security-store.js';
import { trustedLoginIp } from './login-security-metadata.js';
import { JSON_BODY_LIMITS, readJsonWithLimit, RequestBodyTooLargeError } from '../modules/utils.js';

export function securityJson(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...headers,
        },
    });
}

export function securityUnavailable(code = 'login_security_unavailable') {
    return securityJson({ error: '登录安全服务暂不可用，请稍后重试', code }, 503);
}

export function loginLocked(lockedUntil) {
    const retryAfter = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    return securityJson(
        { error: '登录尝试过多，请稍后重试', code: 'login_locked', retryAfter, lockedUntil },
        429,
        { 'Retry-After': String(retryAfter) }
    );
}

export async function loginSecurityContext(request, env) {
    if (!env.MISUB_SECURITY_DB) return { store: null };
    const store = new LoginSecurityStore(env.MISUB_SECURITY_DB);
    const ip = trustedLoginIp(request);
    const config = await store.config(ip);
    if (!config.enabled) return { store: null };
    if (!ip) return { response: securityUnavailable('login_source_unavailable') };
    const lockedUntil =
        config.locked_until > Math.max(Date.now(), config.clock_ms) ? config.locked_until : null;
    return lockedUntil ? { response: loginLocked(lockedUntil) } : { store, ip };
}

function pageQuery(request) {
    const search = new URL(request.url).searchParams;
    const read = (key, fallback, max) => {
        const values = search.getAll(key);
        if (!values.length) return fallback;
        if (values.length !== 1 || !/^[1-9]\d{0,15}$/.test(values[0]))
            throw new Error('invalid_page');
        const value = Number(values[0]);
        if (!Number.isSafeInteger(value) || value > max) throw new Error('invalid_page');
        return value;
    };
    return { before: read('before', null, Number.MAX_SAFE_INTEGER), limit: read('limit', 20, 50) };
}

// Called only after the API router's signed administrator-session check.
export async function handleLoginSecurityAdmin(request, env, path) {
    const reading = path === '/admin/notifications/read';
    const method = reading ? 'POST' : 'GET';
    if (request.method !== method)
        return securityJson({ error: 'Method Not Allowed' }, 405, { Allow: method });
    let page;
    let ids;
    try {
        if (reading) {
            const origin = request.headers.get('Origin');
            if (
                (origin && origin !== new URL(request.url).origin) ||
                request.headers.get('Sec-Fetch-Site') === 'cross-site'
            ) {
                return securityJson({ error: 'Forbidden' }, 403);
            }
            if (
                (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !==
                'application/json'
            ) {
                return securityJson({ error: 'JSON required' }, 415);
            }
            const body = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);
            ids = body?.ids;
            if (
                !Array.isArray(ids) ||
                !ids.length ||
                ids.length > 50 ||
                !ids.every((id) => Number.isSafeInteger(id) && id > 0)
            ) {
                throw new Error('invalid_ids');
            }
        } else {
            page = pageQuery(request);
        }
    } catch (error) {
        return securityJson(
            { error: 'Invalid request' },
            error instanceof RequestBodyTooLargeError ? 413 : 400
        );
    }
    try {
        const store = env.MISUB_SECURITY_DB ? new LoginSecurityStore(env.MISUB_SECURITY_DB) : null;
        let enabled = store ? (await store.config()).enabled === 1 : false;
        if (reading) {
            if (enabled) enabled = await store.markRead(ids);
            return securityJson({ success: true, enabled });
        }
        const data = enabled
            ? await store.list({ ...page, audit: path === '/admin/login-audit' })
            : { items: [], unreadCount: 0, nextCursor: null };
        return securityJson({ success: true, enabled, ...data });
    } catch {
        return securityUnavailable();
    }
}
