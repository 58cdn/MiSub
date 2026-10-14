// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { createSessionFixture } from '../fixtures/session-authority.js';
import { securityDatabase } from '../fixtures/login-security-db.js';
const opened = [];
afterEach(() => opened.splice(0).forEach((close) => close()));
function fixture() {
    const session = createSessionFixture();
    const security = securityDatabase();
    opened.push(
        () => session.close(),
        () => security.sqlite.close()
    );
    return { ...session, security, env: { ...session.env, MISUB_SECURITY_DB: security.binding } };
}
function request(path, body, cookie = '', trusted = true) {
    const r = new Request('https://session.fixture.invalid/api' + path, {
        method: 'POST',
        headers: {
            Origin: 'https://session.fixture.invalid',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '203.0.113.1',
            Cookie: cookie,
        },
        body: JSON.stringify(body),
    });
    if (trusted) Object.defineProperty(r, 'cf', { value: { colo: 'TEST' } });
    return r;
}
const rpc = (f, path, body, cookie, trusted) =>
    handleApiRequest(request(path, body, cookie, trusted), f.env);
describe('durable sessions share the login security password guard', () => {
    it('counts both password entrypoints toward the same lock before any ticket or SID is issued', async () => {
        const f = fixture();
        for (let n = 0; n < 10; n++) {
            const response = await rpc(f, n % 2 ? '/login' : '/session/prepare', {
                password: 'wrong',
            });
            expect(response.status).toBe(n === 9 ? 429 : 401);
            expect(response.headers.getSetCookie()).toHaveLength(0);
        }
        for (const path of ['/session/prepare', '/login']) {
            const response = await rpc(f, path, { password: 'synthetic-password' });
            expect(response.status).toBe(429);
            expect(response.headers.getSetCookie()).toHaveLength(0);
        }
        expect(Object.keys(f.state().tickets)).toHaveLength(0);
        expect(Object.keys(f.state().sessions)).toHaveLength(0);
    });
    it('keeps a failed-attempt warning through prepare and returns it on the password login', async () => {
        const f = fixture();
        await rpc(f, '/session/prepare', { password: 'wrong' });
        const prepared = await rpc(f, '/session/prepare', { password: 'synthetic-password' });
        expect(prepared.status).toBe(200);
        const { ticket } = await prepared.json();
        const response = await rpc(f, '/login', { password: 'synthetic-password', ticket });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result.loginSecurity.enabled).toBe(true);
        expect(result.loginSecurity.warning).toBeTruthy();
        const cookie = response.headers
            .getSetCookie()
            .map((c) => c.split(';')[0])
            .join('; ');
        expect((await rpc(f, '/session/confirm', { ticket }, cookie)).status).toBe(200);
    });
    it('fails closed without a trusted source or when the security store is unavailable', async () => {
        const f = fixture();
        expect(
            (await rpc(f, '/session/prepare', { password: 'synthetic-password' }, '', false)).status
        ).toBe(503);
        f.env.MISUB_SECURITY_DB = {
            prepare() {
                throw new Error('fixture outage');
            },
        };
        for (const path of ['/session/prepare', '/login']) {
            const response = await rpc(f, path, { password: 'synthetic-password' });
            expect(response.status).toBe(503);
            expect(response.headers.getSetCookie()).toHaveLength(0);
        }
        expect(Object.keys(f.state().tickets)).toHaveLength(0);
    });
});
