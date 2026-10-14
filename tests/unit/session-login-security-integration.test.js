// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import { createSessionFixture } from '../fixtures/session-authority.js';
import { securityDatabase } from '../fixtures/login-security-db.js';
import { SessionAuthority } from '../../functions/modules/session-authority.js';
import { LoginSecurityStore } from '../../functions/services/login-security-store.js';
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
const password = 'synthetic-password';
const prepare = async (f) => (await (await rpc(f, '/session/prepare', { password })).json()).ticket;
const counts = (f) => ({
    audits: f.security.sqlite
        .prepare("SELECT COUNT(*) n FROM login_security_events WHERE type='login_success'")
        .get().n,
    failures: f.security.sqlite.prepare('SELECT COUNT(*) n FROM login_security_failures').get().n,
});
const cookies = (response) =>
    response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
describe('durable sessions share the login security password guard', () => {
    it('rejects non-string passwords without counting or allocating state', async () => {
        const f = fixture();
        for (const path of ['/session/prepare', '/login']) {
            for (const value of [null, {}, [], 42])
                expect((await rpc(f, path, { password: value })).status).toBe(400);
        }
        expect(counts(f)).toEqual({ audits: 0, failures: 0 });
        expect(Object.keys(f.state().tickets)).toHaveLength(0);
    });
    it('keeps warnings when the login ticket is missing, invalid or the session store fails', async () => {
        const f = fixture();
        await rpc(f, '/login', { password: 'wrong' });
        const ticket = await prepare(f);
        for (const value of [undefined, { ...ticket, cancelToken: '0'.repeat(64) }]) {
            const response = await rpc(f, '/login', { password, ticket: value });
            expect([400, 403]).toContain(response.status);
            expect(response.headers.getSetCookie()).toHaveLength(0);
            expect(counts(f)).toEqual({ audits: 0, failures: 1 });
        }
        f.setUnavailable(true);
        expect((await rpc(f, '/login', { password, ticket })).status).toBe(503);
        expect(counts(f)).toEqual({ audits: 0, failures: 1 });
        f.setUnavailable(false);
        const result = await (await rpc(f, '/login', { password, ticket })).json();
        expect(result.loginSecurity.warning.failedAttempts).toBe(1);
    });
    it.each([false, true])(
        'replays one audit and the original warning (initial warning=%s)',
        async (warn) => {
            const f = fixture();
            if (warn) await rpc(f, '/login', { password: 'wrong' });
            const ticket = await prepare(f);
            const first = await (await rpc(f, '/login', { password, ticket })).json();
            await rpc(f, '/login', { password: 'wrong' });
            for (let n = 0; n < 3; n++) {
                const response = await rpc(f, '/login', { password, ticket });
                expect(response.status).toBe(200);
                expect(response.headers.getSetCookie()).toHaveLength(0);
                expect((await response.json()).loginSecurity).toEqual(first.loginSecurity);
            }
            expect(counts(f)).toEqual({ audits: 1, failures: 1 });
            expect(
                f.security.sqlite.prepare('SELECT failures FROM login_security_ips').get().failures
            ).toBe(1);
        }
    );
    it('does not repeat a success committed before a lost D1 acknowledgement', async () => {
        const f = fixture();
        await rpc(f, '/login', { password: 'wrong' });
        const ticket = await prepare(f);
        const batch = f.security.binding.batch;
        f.security.binding.batch = async (statements) => {
            await batch(statements);
            f.security.binding.batch = batch;
            throw new Error('synthetic lost acknowledgement');
        };
        const uncertain = await rpc(f, '/login', { password, ticket });
        expect(uncertain.status).toBe(503);
        expect(cookies(uncertain)).toBe('');
        const response = await rpc(f, '/login', { password, ticket });
        expect(response.status).toBe(200);
        expect(cookies(response)).toBe('');
        expect((await response.json()).loginSecurity.warning.failedAttempts).toBe(1);
        expect(counts(f)).toEqual({ audits: 1, failures: 0 });
        expect(Object.values(f.state().sessions).every((s) => !s.active)).toBe(true);
    });
    it('leaves no audit when a session commit acknowledgement is lost and never reissues its Cookie', async () => {
        const f = fixture(),
            ticket = await prepare(f);
        f.writeHook((query, args) => {
            f.sql.prepare(query).run(...args);
            throw new Error('synthetic lost session acknowledgement');
        });
        const first = await rpc(f, '/login', { password, ticket });
        expect(first.status).toBe(503);
        expect(cookies(first)).toBe('');
        expect(counts(f).audits).toBe(0);
        const retry = await rpc(f, '/login', { password, ticket });
        expect(retry.status).toBe(200);
        expect(cookies(retry)).toBe('');
        expect(Object.values(f.state().sessions).every((s) => !s.active)).toBe(true);
    });
    it('keeps admission effective when the tenth failure commits after the success transaction', async () => {
        const f = fixture(),
            ticket = await prepare(f);
        const batch = f.security.binding.batch;
        f.security.binding.batch = async (statements) => {
            f.security.binding.batch = batch;
            const result = await batch(statements);
            const store = new LoginSecurityStore(f.security.binding);
            for (let n = 0; n < 10; n++) await store.record('203.0.113.1', false);
            return result;
        };
        const response = await rpc(f, '/login', { password, ticket });
        expect(response.status).toBe(200);
        expect(cookies(response)).not.toBe('');
        expect((await rpc(f, '/session/confirm', { ticket }, cookies(response))).status).toBe(200);
        expect(counts(f)).toEqual({ audits: 1, failures: 10 });
        expect((await rpc(f, '/login', { password, ticket })).status).toBe(429);
    });
    it.each(['outage', 'lock'])(
        'preserves the old session if final security admission loses to %s',
        async (failure) => {
            const f = fixture();
            const oldTicket = await prepare(f);
            const oldResponse = await rpc(f, '/login', { password, ticket: oldTicket });
            const oldId = (await oldResponse.json()).id;
            const oldCookie = cookies(oldResponse);
            expect(
                (await rpc(f, '/session/confirm', { ticket: oldTicket }, oldCookie)).status
            ).toBe(200);
            const ticket = await prepare(f);
            const batch = f.security.binding.batch;
            f.security.binding.batch = async (statements) => {
                f.security.binding.batch = batch;
                if (failure === 'outage') throw new Error('synthetic outage');
                const store = new LoginSecurityStore(f.security.binding);
                for (let i = 0; i < 10; i++) await store.record('203.0.113.1', false);
                return batch(statements);
            };
            const response = await rpc(
                f,
                '/login',
                { password, ticket, priorIds: [oldId], priorTickets: [oldTicket] },
                oldCookie
            );
            expect(response.status).toBe(failure === 'outage' ? 503 : 429);
            expect(cookies(response)).toBe('');
            expect(
                (await new SessionAuthority(f.binding).authenticate(oldCookie)).isAuthenticated
            ).toBe(true);
            expect(counts(f).audits).toBe(1);
        }
    );
    it('replaces proven old targets only after receiving and confirming the admitted Cookie', async () => {
        const f = fixture();
        const oldTicket = await prepare(f);
        const oldResponse = await rpc(f, '/login', { password, ticket: oldTicket });
        const oldId = (await oldResponse.json()).id,
            oldCookie = cookies(oldResponse);
        await rpc(f, '/session/confirm', { ticket: oldTicket }, oldCookie);
        const ticket = await prepare(f);
        const response = await rpc(
            f,
            '/login',
            { password, ticket, priorIds: [oldId], priorTickets: [oldTicket] },
            oldCookie
        );
        const authority = new SessionAuthority(f.binding);
        expect((await authority.authenticate(oldCookie)).isAuthenticated).toBe(true);
        expect((await rpc(f, '/session/confirm', { ticket }, cookies(response))).status).toBe(200);
        expect((await authority.authenticate(oldCookie)).isAuthenticated).toBe(false);
        expect((await authority.authenticate(cookies(response))).isAuthenticated).toBe(true);
    });
    it('cannot activate a SID cancelled while its security transaction is in flight', async () => {
        const f = fixture(),
            ticket = await prepare(f);
        const authority = new SessionAuthority(f.binding),
            batch = f.security.binding.batch;
        f.security.binding.batch = async (statements) => {
            f.security.binding.batch = batch;
            const recovery = { id: 'a'.repeat(32), proof: 'b'.repeat(64), createdAt: Date.now() };
            const snapshot = await authority.capture({ recovery, tickets: [ticket] });
            await authority.logout(recovery, snapshot.receipt);
            return batch(statements);
        };
        const response = await rpc(f, '/login', { password, ticket });
        expect(response.status).toBe(200);
        expect((await rpc(f, '/session/confirm', { ticket }, cookies(response))).status).toBe(409);
        expect((await authority.authenticate(cookies(response))).isAuthenticated).toBe(false);
    });
    it('bounds issued-ticket replay to its deadline, including an active SID', async () => {
        const f = fixture();
        let now = Date.now();
        const authority = new SessionAuthority(f.binding, { now: () => now });
        const { ticket } = await authority.issueTicket();
        const issued = await authority.login({ ticket });
        await authority.confirm(ticket, issued.setCookies[0].split(';')[0]);
        now = ticket.deadline;
        await expect(authority.login({ ticket })).rejects.toMatchObject({ code: 'ticket_expired' });
    });
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
