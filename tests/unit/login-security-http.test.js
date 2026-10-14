// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLogin, createSignedToken } from '../../functions/modules/auth-middleware.js';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import {
    trustedLoginIp,
    normalizeLoginIp,
    loginDevice,
} from '../../functions/services/login-security-metadata.js';
import {
    LoginSecurityStore,
    LOGIN_LOCK_MS,
} from '../../functions/services/login-security-store.js';
import { SettingsCache } from '../../functions/storage-adapter.js';
import { securityDatabase } from '../fixtures/login-security-db.js';

const databases = [];
let env;
let db;
const IP = '203.0.113.1';
function login(password = 'fixture-password', headers = {}, trusted = true) {
    const request = new Request('https://example.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP, ...headers },
        body: JSON.stringify({ password }),
    });
    if (trusted) Object.defineProperty(request, 'cf', { value: { colo: 'TEST' } });
    return request;
}
async function admin(path, options = {}) {
    const token = await createSignedToken(env.COOKIE_SECRET, String(Date.now()));
    return new Request(`https://example.com/api${path}`, {
        ...options,
        headers: { Cookie: `auth_session=${token}`, ...options.headers },
    });
}
beforeEach(() => {
    SettingsCache.clear();
    db = securityDatabase();
    databases.push(db.sqlite);
    env = {
        ADMIN_PASSWORD: 'fixture-password',
        COOKIE_SECRET: 'fixture-cookie-secret',
        MISUB_SECURITY_DB: db.binding,
        MISUB_KV: {
            get: async (key) => (key === 'SYSTEM_COOKIE_SECRET' ? 'fixture-cookie-secret' : null),
            put: vi.fn(),
            delete: vi.fn(),
        },
    };
});
afterEach(() => {
    vi.restoreAllMocks();
    databases.splice(0).forEach((sqlite) => sqlite.close());
});

describe('login security HTTP boundaries', () => {
    it('rechecks a switch disabled after the initial config read before listing or marking events', async () => {
        await handleLogin(login(), env);
        const prepare = db.binding.prepare;
        db.binding.prepare = (sql) => {
            const statement = prepare(sql);
            if (!sql.includes('SELECT c.*')) return statement;
            return {
                ...statement,
                bind(...values) {
                    const bound = statement.bind(...values);
                    return {
                        ...bound,
                        async first() {
                            const previous = await bound.first();
                            db.sqlite.exec('UPDATE login_security_config SET enabled=0');
                            return previous;
                        },
                    };
                },
            };
        };
        const list = await handleApiRequest(await admin('/admin/notifications'), env);
        expect(await list.json()).toEqual({
            success: true,
            enabled: false,
            items: [],
            unreadCount: 0,
            nextCursor: null,
        });
        db.sqlite.exec('UPDATE login_security_config SET enabled=1');
        const read = await handleApiRequest(
            await admin('/admin/notifications/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [1] }),
            }),
            env
        );
        expect(await read.json()).toEqual({ success: true, enabled: false });
        expect(
            db.sqlite.prepare('SELECT read_at FROM login_security_events').get().read_at
        ).toBeNull();
    });

    it('returns 401 for 1–9, 429 on 10/11 including correct passwords, with no cookie or expiry extension', async () => {
        let now = 1791900000000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        for (let i = 0; i < 9; i++)
            expect((await handleLogin(login('wrong'), env)).status).toBe(401);
        const tenth = await handleLogin(login('wrong'), env);
        expect(tenth.status).toBe(429);
        const body = await tenth.json();
        expect(body).toMatchObject({
            code: 'login_locked',
            retryAfter: 600,
            lockedUntil: now + LOGIN_LOCK_MS,
        });
        expect(tenth.headers.get('Retry-After')).toBe('600');
        now += 1000;
        const eleventh = await handleLogin(login(), env);
        expect(eleventh.status).toBe(429);
        expect(eleventh.headers.get('Set-Cookie')).toBeNull();
        expect((await eleventh.json()).lockedUntil).toBe(body.lockedUntil);
        const malformed = login();
        Object.defineProperty(malformed, 'text', {
            value: () => {
                throw new Error('body must not be read while locked');
            },
        });
        expect((await handleLogin(malformed, env)).status).toBe(429);
        now = body.lockedUntil;
        const success = await handleLogin(login(), env);
        expect(success.status).toBe(200);
        expect(success.headers.get('Set-Cookie')).toMatch(/HttpOnly; Secure; SameSite=Lax/);
        expect((await success.json()).loginSecurity.warning.failedAttempts).toBe(10);
    });

    it('audits coarse device metadata and warns on failures from other IPs once', async () => {
        await handleLogin(login('wrong', { 'CF-Connecting-IP': '203.0.113.99' }), env);
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0 PRIVATE-UA';
        const first = await handleLogin(login('fixture-password', { 'User-Agent': ua }), env);
        expect((await first.json()).loginSecurity.warning.failedAttempts).toBe(1);
        expect((await (await handleLogin(login(), env)).json()).loginSecurity.warning).toBeNull();
        const response = await handleApiRequest(await admin('/admin/notifications'), env);
        const data = await response.json();
        expect(data.items).toHaveLength(3);
        expect(data.items.find((r) => r.browser === 'Firefox')).toMatchObject({
            ip: IP,
            os: 'Windows',
            device: 'desktop',
            target: 'security',
        });
        expect(JSON.stringify(data)).not.toMatch(
            /PRIVATE-UA|fixture-password|fixture-cookie-secret|operation_id/
        );
        expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('keeps existing login working without a binding and when the explicit switch is off', async () => {
        delete env.MISUB_SECURITY_DB;
        expect(
            (await (await handleLogin(login('fixture-password', {}, false), env)).json())
                .loginSecurity
        ).toEqual({ enabled: false, warning: null });
        env.MISUB_SECURITY_DB = db.binding;
        db.sqlite.exec('UPDATE login_security_config SET enabled=0');
        const result = await handleLogin(login('fixture-password', {}, false), env);
        expect(result.status).toBe(200);
        expect((await result.json()).loginSecurity.enabled).toBe(false);
        expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_events').get().n).toBe(
            0
        );
        const list = await handleApiRequest(await admin('/admin/notifications'), env);
        expect(await list.json()).toEqual({
            success: true,
            enabled: false,
            items: [],
            unreadCount: 0,
            nextCursor: null,
        });
    });

    it('reads a disabled switch and an existing lock in the same snapshot', async () => {
        for (let i = 0; i < 10; i++) await handleLogin(login('wrong'), env);
        db.sqlite.exec('UPDATE login_security_config SET enabled=0');
        const response = await handleLogin(login(), env);
        expect(response.status).toBe(200);
        expect((await response.json()).loginSecurity).toEqual({ enabled: false, warning: null });
    });

    it('keeps default-password and failed-attempt warnings independent', async () => {
        delete env.ADMIN_PASSWORD;
        await handleLogin(login('wrong'), env);
        const body = await (await handleLogin(login('admin'), env)).json();
        expect(body.securityWarning.type).toBe('default_admin_password');
        expect(body.loginSecurity.warning.failedAttempts).toBe(1);
    });

    it('fails new login closed for missing schema and transaction faults without logging raw errors', async () => {
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        db.sqlite.exec(
            "CREATE TRIGGER reject_audit BEFORE INSERT ON login_security_events BEGIN SELECT RAISE(ABORT,'sensitive raw fixture'); END"
        );
        const failure = await handleLogin(login(), env);
        expect(failure.status).toBe(503);
        expect(await failure.json()).toEqual({
            error: '登录安全服务暂不可用，请稍后重试',
            code: 'login_security_unavailable',
        });
        expect(failure.headers.get('Set-Cookie')).toBeNull();
        expect(errorLog).not.toHaveBeenCalled();
        db.sqlite.exec('DROP TABLE login_security_config');
        expect((await handleLogin(login(), env)).status).toBe(503);
        expect((await handleApiRequest(await admin('/admin/notifications'), env)).status).toBe(503);
    });

    it('requires trusted platform IP and ignores fake forwarding headers', async () => {
        const untrusted = await handleLogin(
            login('fixture-password', { 'X-Forwarded-For': IP }, false),
            env
        );
        expect(untrusted.status).toBe(503);
        expect((await untrusted.json()).code).toBe('login_source_unavailable');
        for (let i = 0; i < 10; i++)
            await handleLogin(
                login('wrong', {
                    'X-Forwarded-For': `203.0.113.${i + 2}`,
                    'X-Real-IP': `198.51.100.${i + 2}`,
                }),
                env
            );
        expect((await handleLogin(login(), env)).status).toBe(429);
        expect(
            (await handleLogin(login('fixture-password', { 'CF-Worker': 'example.com' }), env))
                .status
        ).toBe(503);
    });

    it('rejects invalid login bodies without counting them or leaking their content', async () => {
        for (const password of [null, 123, {}, []])
            expect((await handleLogin(login(password), env)).status).toBe(400);
        const req = login();
        Object.defineProperty(req, 'text', { value: async () => '{"password":"PRIVATE-BODY' });
        const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await handleLogin(req, env)).status).toBe(400);
        expect(logger).not.toHaveBeenCalled();
        expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_security_failures').get().n).toBe(
            0
        );
    });

    it('requires administrator cookies for lists, read mutations and diagnostic password checks', async () => {
        env.ENABLE_AUTH_DIAGNOSTICS = 'true';
        for (const path of [
            '/admin/notifications',
            '/admin/login-audit',
            '/admin/notifications/read',
            '/auth_check',
            '/auth_debug',
        ]) {
            const req = new Request(`https://example.com/api${path}`, {
                headers: { Authorization: 'Bearer mp1_fixture' },
            });
            expect((await handleApiRequest(req, env)).status).toBe(401);
        }
        const diagnostic = await handleApiRequest(
            await admin('/auth_check', {
                method: 'POST',
                body: JSON.stringify({ password: 'fixture-password' }),
            }),
            env
        );
        expect(diagnostic.status).toBe(200);
    });

    it('limits methods, page sizes and read IDs; rejects cross-site changes and remains idempotent', async () => {
        await handleLogin(login(), env);
        for (const query of [
            'limit=0',
            'limit=51',
            'limit=2&limit=3',
            'before=-1',
            'before=0',
            'before=9007199254740992',
            'before=x',
        ]) {
            expect(
                (await handleApiRequest(await admin(`/admin/notifications?${query}`), env)).status
            ).toBe(400);
        }
        expect(
            (await handleApiRequest(await admin('/admin/notifications', { method: 'POST' }), env))
                .status
        ).toBe(405);
        expect((await handleApiRequest(await admin('/admin/notifications/read'), env)).status).toBe(
            405
        );
        const requestRead = (ids, headers = {}) =>
            admin('/admin/notifications/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ ids }),
            });
        for (const ids of [[], [0], ['1'], Array(51).fill(1), [1.1]])
            expect((await handleApiRequest(await requestRead(ids), env)).status).toBe(400);
        expect(
            (
                await handleApiRequest(
                    await requestRead([1], { Origin: 'https://evil.example' }),
                    env
                )
            ).status
        ).toBe(403);
        expect(
            (
                await handleApiRequest(
                    await requestRead([1], { 'Sec-Fetch-Site': 'cross-site' }),
                    env
                )
            ).status
        ).toBe(403);
        for (let i = 0; i < 2; i++)
            expect(
                await (await handleApiRequest(await requestRead([1, 1, 999]), env)).json()
            ).toEqual({ success: true, enabled: true });
        expect(
            (await (await handleApiRequest(await admin('/admin/notifications'), env)).json())
                .unreadCount
        ).toBe(0);
    });

    it('does not access login-security storage for existing authenticated or public traffic', async () => {
        const unavailable = {
            prepare() {
                throw new Error('security storage must not be used');
            },
        };
        env.MISUB_SECURITY_DB = unavailable;
        const settings = await handleApiRequest(await admin('/settings'), env);
        expect(settings.status).toBe(200);
        const publicConfig = await handleApiRequest(
            new Request('https://example.com/api/public_config'),
            env
        );
        expect(publicConfig.status).toBe(200);
        expect(env.MISUB_KV.put).not.toHaveBeenCalled();
        expect(env.MISUB_KV.delete).not.toHaveBeenCalled();
    });
});

describe('trusted IP and coarse device parsing', () => {
    it('canonicalizes IPv6 and mapped IPv4 without trusting arbitrary IPv6 override headers', () => {
        expect(normalizeLoginIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
        expect(normalizeLoginIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(trustedLoginIp(login('x', { 'CF-Connecting-IPv6': '2001:db8::99' }))).toBe(IP);
        expect(
            trustedLoginIp(
                login('x', {
                    'CF-Connecting-IP': '240.1.2.3',
                    'CF-Connecting-IPv6': '2001:0db8::1',
                })
            )
        ).toBe('2001:db8::1');
        expect(trustedLoginIp(login('x', { 'CF-Connecting-IP': '240.1.2.3' }))).toBeNull();
        for (const ip of [
            '1.2.3.999',
            '01.2.3.4',
            'example.com',
            '1.2.3.4,5.6.7.8',
            '[::1]',
            'fe80::1%eth0',
            '2001::db8::1',
        ])
            expect(normalizeLoginIp(ip)).toBeNull();
    });
    it('uses full IPv6 addresses as independent keys while equivalent spellings share a counter', async () => {
        for (let i = 0; i < 10; i++)
            await handleLogin(
                login('wrong', {
                    'CF-Connecting-IP': i % 2 ? '2001:db8::1' : '2001:0db8:0:0:0:0:0:1',
                }),
                env
            );
        expect(
            (
                await handleLogin(
                    login('fixture-password', { 'CF-Connecting-IP': '2001:db8::1' }),
                    env
                )
            ).status
        ).toBe(429);
        expect(
            (
                await handleLogin(
                    login('fixture-password', { 'CF-Connecting-IP': '2001:db8::2' }),
                    env
                )
            ).status
        ).toBe(200);
    });
    it('returns fixed enum strings for arbitrary UA input, including script payloads', () => {
        expect(loginDevice(login('x', { 'User-Agent': '<script>alert(1)</script>' }))).toEqual({
            browser: 'Unknown',
            os: 'Unknown',
            device: 'unknown',
        });
        expect(loginDevice(login('x', { 'User-Agent': 'iPhone Mobile Safari/605.1' }))).toEqual({
            browser: 'Safari',
            os: 'iOS',
            device: 'mobile',
        });
        expect(
            loginDevice(login('x', { 'User-Agent': 'Android Tablet Chrome/100 EdgA/100' }))
        ).toEqual({ browser: 'Edge', os: 'Android', device: 'tablet' });
    });
});
