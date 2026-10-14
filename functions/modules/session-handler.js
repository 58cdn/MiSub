import { SessionAuthority, sessionProtocol } from './session-authority.js';
import {
    loginSecurityContext,
    loginLocked,
    securityUnavailable,
} from '../services/login-security.js';
import { loginDevice } from '../services/login-security-metadata.js';
import {
    getAdminPassword,
    getAuthDebugInfo,
    readJsonWithLimit,
    JSON_BODY_LIMITS,
} from './utils.js';

export function sessionResponse(result, status = 200) {
    const { setCookies = [], ...body } = result;
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    for (const value of setCookies) headers.append('Set-Cookie', value);
    return new Response(JSON.stringify(body), { status, headers });
}
export function sessionError(error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    return sessionResponse(
        {
            error: status === 503 ? '会话服务暂时不可用，请稍后重试。' : '会话操作未完成，请重试。',
            code: error?.code || 'session_store_unavailable',
            serverNow: Date.now(),
            ...(error?.code === 'logout_recovery_unconfirmed' ? { settled: error.settled } : {}),
        },
        status
    );
}
const fail = (status, code) => Object.assign(new Error(code), { status, code });
function requireMutation(request) {
    if (request.method !== 'POST') throw fail(405, 'method_not_allowed');
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw fail(400, 'secure_origin_required');
    if (
        request.headers.get('Origin') !== url.origin ||
        request.headers.get('Sec-Fetch-Site') === 'cross-site'
    )
        throw fail(403, 'same_origin_required');
    if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json'))
        throw fail(415, 'json_required');
}
const normalize = (value) =>
    String(value ?? '')
        .replace(/\uFEFF/g, '')
        .replace(/[\u200B-\u200D]/g, '')
        .trim()
        .replace(/^['"]|['"]$/g, '');
async function passwordAccess(request, payload, env) {
    if (typeof payload?.password !== 'string') throw fail(400, 'invalid_password');
    let security;
    try {
        security = await loginSecurityContext(request, env);
        if (security.response) return security;
    } catch {
        return { response: securityUnavailable() };
    }
    const matched = normalize(payload.password) === normalize(await getAdminPassword(env));
    if (security.store && !matched) {
        try {
            const result = await security.store.record(security.ip, false);
            if (result.lockedUntil) return { response: loginLocked(result.lockedUntil) };
        } catch {
            return { response: securityUnavailable() };
        }
    }
    if (!matched) throw fail(401, 'wrong_password');
    return security;
}

export async function handleSessionRequest(request, env, path) {
    try {
        const protocol = sessionProtocol(env);
        if (path === '/session/protocol') {
            if (request.method !== 'GET') throw fail(405, 'method_not_allowed');
            return sessionResponse({ protocol, serverNow: Date.now() });
        }
        if (protocol !== 'd1-v1')
            return sessionResponse({ code: 'session_protocol_disabled' }, 404);
        const authority = new SessionAuthority(env.MISUB_SESSION_DB);
        const header = request.headers.get('Cookie') || '';
        if (path === '/session/check') {
            if (request.method !== 'GET') throw fail(405, 'method_not_allowed');
            const auth = await authority.authenticate(header);
            return sessionResponse({
                protocol,
                authenticated: auth.isAuthenticated,
                ids: auth.ids,
            });
        }
        requireMutation(request);
        const payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);
        if (path === '/session/prepare') {
            const access = await passwordAccess(request, payload, env);
            if (access.response) return access.response;
            return sessionResponse(await authority.issueTicket());
        }
        if (path === '/login') {
            const access = await passwordAccess(request, payload, env);
            if (access.response) return access.response;
            const result = await authority.login(payload, header);
            result.loginSecurity = { enabled: false, warning: null };
            // The pending SID cannot authenticate without its Cookie and confirmation.
            // Recheck admission and commit its one audit before releasing that Cookie.
            if (access.store) {
                try {
                    const summary = await access.store.record(
                        access.ip,
                        true,
                        loginDevice(request),
                        result.id
                    );
                    if (summary.lockedUntil) return loginLocked(summary.lockedUntil);
                    result.loginSecurity = { enabled: summary.enabled, warning: summary.warning };
                } catch {
                    return securityUnavailable();
                }
            }
            if ((await getAuthDebugInfo(env))?.adminPassword?.isDefaultFallback) {
                result.securityWarning = {
                    type: 'default_admin_password',
                    shouldChangePassword: true,
                    message: '当前正在使用默认管理员密码 admin，请登录后立即修改。',
                };
            }
            return sessionResponse(result);
        }
        if (path === '/session/confirm')
            return sessionResponse(await authority.confirm(payload.ticket, header));
        if (path === '/session/capture')
            return sessionResponse(await authority.capture(payload, header));
        if (path === '/logout')
            return sessionResponse(await authority.logout(payload.recovery, payload.receipt));
        if (path === '/session/cleanup') return sessionResponse(await authority.cleanup(header));
        return sessionResponse({ code: 'not_found' }, 404);
    } catch (error) {
        return sessionError(error);
    }
}
