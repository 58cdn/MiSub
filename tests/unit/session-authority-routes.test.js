// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';
import {
    getAuthSessionDiagnostic,
    renewAuthSession,
    createSignedToken,
} from '../../functions/modules/auth-middleware.js';
import { SessionAuthority } from '../../functions/modules/session-authority.js';
import { onRequest } from '../../functions/[[path]].js';
import { createSessionFixture } from '../fixtures/session-authority.js';
const origin = 'https://session-runtime.invalid';
const opened = [];
function fixture(options) {
    const f = createSessionFixture(options);
    opened.push(f);
    return f;
}
afterEach(() => {
    for (const f of opened.splice(0)) f.close();
    vi.restoreAllMocks();
});
const recovery = () => ({
    id: crypto.randomUUID().replaceAll('-', ''),
    proof: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
    createdAt: Date.now(),
});
const header = (jar) => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
function apply(jar, response) {
    for (const value of response.headers.getSetCookie()) {
        const [name, secret] = value.split(';')[0].split('=');
        if (secret) jar.set(name, secret);
        else jar.delete(name);
    }
}
function request(path, body, jar = new Map(), extra = {}) {
    return new Request(origin + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            Cookie: header(jar),
            ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const rpc = (f, path, body, jar, extra) => handleApiRequest(request(path, body, jar, extra), f.env);
async function login(f, jar = new Map(), { confirm = true } = {}) {
    const prepare = await rpc(f, '/session/prepare', { password: 'synthetic-password' }, jar);
    expect(prepare.status).toBe(200);
    apply(jar, prepare);
    const { ticket } = await prepare.json();
    const response = await rpc(f, '/login', { password: 'synthetic-password', ticket }, jar);
    expect(response.status).toBe(200);
    apply(jar, response);
    const body = await response.json();
    if (confirm) expect((await rpc(f, '/session/confirm', { ticket }, jar)).status).toBe(200);
    return { jar, ticket, id: body.id, response };
}
async function capture(f, jar, known = {}) {
    const r = recovery();
    const response = await rpc(f, '/session/capture', { recovery: r, ...known }, jar);
    expect(response.status).toBe(200);
    return { recovery: r, ...(await response.json()) };
}

describe('production session routes with isolated SQLite D1 adapter', () => {
    it.each(['confirm', 'renew'])(
        'a concurrent logout wins over a stale %s CAS read',
        async (operation) => {
            const f = fixture(),
                s = await login(f, new Map(), { confirm: operation === 'renew' });
            const target = await capture(f, s.jar),
                authority = new SessionAuthority(f.binding);
            let release, reached;
            const held = new Promise((done) => {
                release = done;
            });
            const ready = new Promise((done) => {
                reached = done;
            });
            f.readHook(async () => {
                reached();
                await held;
            });
            const running = (
                operation === 'confirm'
                    ? authority.confirm(s.ticket, header(s.jar))
                    : authority.renew(header(s.jar))
            ).then(
                () => ({ ok: true }),
                (error) => ({ ok: false, code: error.code })
            );
            await ready;
            await authority.logout(target.recovery, target.receipt);
            release();
            const result = await running;
            if (operation === 'confirm') expect(result.ok).toBe(false);
            expect((await authority.authenticate(header(s.jar))).isAuthenticated).toBe(false);
        }
    );
    it('keeps public assets available during a session store outage and preserves protected 503', async () => {
        const f = fixture(),
            s = await login(f);
        f.setUnavailable(true);
        const env = { ...f.env, MISUB_KV: { get: async () => null } };
        const asset = await onRequest({
            env,
            request: new Request(origin + '/assets/app.js'),
            next: async () => new Response('asset'),
        });
        expect(asset.status).toBe(200);
        const privateResponse = await onRequest({
            env,
            request: request('/data', undefined, s.jar),
            next: async () => new Response('unused'),
        });
        expect(privateResponse.status).toBe(503);
        expect(await privateResponse.text()).not.toContain('synthetic');
    });
    it('issues CSPRNG cookies, requires confirmation, and rejects legacy bearer tokens in enabled mode', async () => {
        const f = fixture(),
            session = await login(f, new Map(), { confirm: false });
        expect(
            (await (await rpc(f, '/session/check', undefined, session.jar)).json()).authenticated
        ).toBe(false);
        expect(session.response.headers.get('set-cookie')).toMatch(
            /__Host-misub_sid_[a-f0-9]{32}=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict/
        );
        expect(
            (await rpc(f, '/session/confirm', { ticket: session.ticket }, session.jar)).status
        ).toBe(200);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, session.jar), f.env))
                .isAuthenticated
        ).toBe(true);
        const old = await createSignedToken('synthetic-legacy-secret', String(Date.now()));
        const legacy = new Map([['auth_session', old]]);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, legacy), f.env))
                .isAuthenticated
        ).toBe(false);
        expect(JSON.stringify(f.state())).not.toContain(session.ticket.cancelToken);
    });
    it.each(['login-first', 'logout-first'])(
        'prevents delayed login from reviving logout: %s',
        async (order) => {
            const f = fixture(),
                jar = new Map();
            const prepared = await rpc(
                f,
                '/session/prepare',
                { password: 'synthetic-password' },
                jar
            );
            apply(jar, prepared);
            const { ticket } = await prepared.json();
            let delayed;
            if (order === 'login-first')
                delayed = await rpc(f, '/login', { password: 'synthetic-password', ticket }, jar);
            const target = await capture(f, jar, { tickets: [ticket] });
            const loggedOut = await rpc(f, '/logout', target, jar);
            expect(loggedOut.status).toBe(200);
            expect(loggedOut.headers.has('set-cookie')).toBe(false);
            if (!delayed)
                delayed = await rpc(f, '/login', { password: 'synthetic-password', ticket }, jar);
            apply(jar, delayed);
            expect((await rpc(f, '/session/confirm', { ticket }, jar)).status).not.toBe(200);
            expect(
                (await (await rpc(f, '/session/check', undefined, jar)).json()).authenticated
            ).toBe(false);
        }
    );
    it('renews server expiry without Set-Cookie and cannot restore a revoked session', async () => {
        const f = fixture(),
            s = await login(f),
            target = await capture(f, s.jar);
        const original = new Response('private');
        const renewed = await renewAuthSession(
            request('/private', undefined, s.jar),
            f.env,
            original,
            { isAuthenticated: true, shouldRenew: true }
        );
        expect(renewed.headers.has('set-cookie')).toBe(false);
        await rpc(f, '/logout', target, s.jar);
        await renewAuthSession(request('/private', undefined, s.jar), f.env, new Response('late'), {
            isAuthenticated: true,
            shouldRenew: true,
        });
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, s.jar), f.env))
                .isAuthenticated
        ).toBe(false);
    });
    it('late logout response, cleanup and repeated old receipt preserve a newer login', async () => {
        const f = fixture(),
            old = await login(f),
            target = await capture(f, old.jar);
        const lateLogout = await rpc(f, '/logout', target, old.jar);
        const lateCleanup = await rpc(f, '/session/cleanup', {}, old.jar);
        const newer = await login(f, old.jar);
        apply(newer.jar, lateLogout);
        apply(newer.jar, lateCleanup);
        expect((await rpc(f, '/logout', target, newer.jar)).status).toBe(200);
        const auth = await getAuthSessionDiagnostic(
            request('/private', undefined, newer.jar),
            f.env
        );
        expect(auth.ids).toContain(newer.id);
        expect(auth.ids).not.toContain(old.id);
    });
    it('replays the same capture after a lost response without widening to new cookies', async () => {
        const f = fixture(),
            old = await login(f),
            target = await capture(f, old.jar);
        const newer = await login(f, old.jar);
        const retried = await (
            await rpc(f, '/session/capture', { recovery: target.recovery }, newer.jar)
        ).json();
        expect(retried.receipt).toEqual(target.receipt);
        await rpc(f, '/logout', { recovery: target.recovery, receipt: retried.receipt }, newer.jar);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, newer.jar), f.env)).ids
        ).toEqual([newer.id]);
    });
    it('retries an unconfirmed committed logout with its exact signed receipt', async () => {
        const f = fixture(),
            old = await login(f),
            target = await capture(f, old.jar);
        f.writeHook((query, args) => {
            f.sql.prepare(query).run(...args);
            throw new Error('lost response');
        });
        expect((await rpc(f, '/logout', target, old.jar)).status).toBe(503);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, old.jar), f.env))
                .isAuthenticated
        ).toBe(false);
        const newer = await login(f, old.jar);
        expect((await rpc(f, '/logout', target, newer.jar)).status).toBe(200);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, newer.jar), f.env)).ids
        ).toEqual([newer.id]);
    });
    it('does not allocate snapshots or change the revision for fabricated absent targets', async () => {
        const f = fixture();
        for (let index = 0; index < 140; index++) {
            const response = await rpc(f, '/session/capture', {
                recovery: recovery(),
                ids: [crypto.randomUUID().replaceAll('-', '')],
            });
            expect(response.status).toBe(409);
        }
        expect(Object.keys(f.state().snapshots)).toHaveLength(0);
        expect(f.sql.prepare('SELECT revision FROM misub_session_authority').get().revision).toBe(
            0
        );
        const real = await login(f);
        expect((await capture(f, real.jar)).ids).toContain(real.id);
    });
    it('retains signed retries after cache GC while rejecting a stale capture request', async () => {
        let now = Date.now();
        const f = fixture(),
            a = new SessionAuthority(f.binding, { now: () => now });
        const s = await login(f),
            r = recovery(),
            snapshot = await a.capture({ recovery: r }, header(s.jar));
        now += 11 * 60_000;
        await a.issueTicket();
        expect(Object.keys(f.state().snapshots)).toHaveLength(0);
        await expect(a.capture({ recovery: r }, header(s.jar))).rejects.toMatchObject({
            code: 'recovery_capture_expired',
        });
        await a.logout(r, snapshot.receipt);
        expect((await a.authenticate(header(s.jar))).isAuthenticated).toBe(false);
    });
    it('rejects forged receipt scope and wrong cancellation proof', async () => {
        const f = fixture(),
            s = await login(f),
            target = await capture(f, s.jar);
        const forged = {
            ...target,
            receipt: {
                ...target.receipt,
                payload: target.receipt.payload.replace(s.id, 'a'.repeat(32)),
            },
        };
        expect((await rpc(f, '/logout', forged, s.jar)).status).toBe(403);
        expect(
            (
                await rpc(
                    f,
                    '/logout',
                    { ...target, recovery: { ...target.recovery, proof: 'b'.repeat(64) } },
                    s.jar
                )
            ).status
        ).toBe(403);
        expect(
            (await getAuthSessionDiagnostic(request('/private', undefined, s.jar), f.env))
                .isAuthenticated
        ).toBe(true);
    });
    it('rejects unauthenticated issuance, unsafe origins and GET mutations', async () => {
        const f = fixture();
        expect((await rpc(f, '/session/prepare', { password: 'wrong' })).status).toBe(401);
        expect(
            (
                await rpc(f, '/session/prepare', { password: 'synthetic-password' }, undefined, {
                    Origin: 'https://other.invalid',
                })
            ).status
        ).toBe(403);
        expect((await rpc(f, '/logout')).status).toBe(405);
        expect((await rpc(f, '/session/confirm')).status).toBe(405);
        expect(Object.keys(f.state().tickets)).toHaveLength(0);
    });
    it('fails closed on a missing binding, missing schema, malformed state and database outage', async () => {
        const missing = fixture({ initialize: false });
        expect((await rpc(missing, '/session/check')).status).toBe(503);
        const f = fixture(),
            s = await login(f);
        f.setUnavailable(true);
        expect((await rpc(f, '/session/check', undefined, s.jar)).status).toBe(503);
        f.setUnavailable(false);
        f.sql
            .prepare('UPDATE misub_session_authority SET document=?')
            .run(JSON.stringify({ ...f.state(), receiptKey: null }));
        expect((await rpc(f, '/session/check', undefined, s.jar)).status).toBe(503);
        delete f.env.MISUB_SESSION_DB;
        expect((await rpc(f, '/session/check', undefined, s.jar)).status).toBe(503);
    });
    it('requires opt-in and never accesses a bound security database in legacy mode', async () => {
        const f = fixture();
        delete f.env.SESSION_AUTH_MODE;
        expect(await (await rpc(f, '/session/protocol')).json()).toMatchObject({
            protocol: 'legacy',
        });
        expect((await rpc(f, '/session/check')).status).toBe(404);
        expect(f.calls).toHaveLength(0);
        f.env.SESSION_AUTH_MODE = 'typo';
        expect((await rpc(f, '/session/protocol')).status).toBe(503);
    });
    it('rejects duplicate/oversized credentials and uses primary reads', async () => {
        const f = fixture(),
            s = await login(f),
            text = header(s.jar);
        const response = await handleApiRequest(
            new Request(origin + '/api/session/check', { headers: { Cookie: text + '; ' + text } }),
            f.env
        );
        expect(response.status).toBe(400);
        expect(
            f.calls.filter((call) => call.mode).every((call) => call.mode === 'first-primary')
        ).toBe(true);
    });
});
