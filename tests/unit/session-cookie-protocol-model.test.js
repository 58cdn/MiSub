// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    SessionCookieModel,
    applyFixtureCookie,
    fixtureCookieHeader,
} from '../../experiments/session-cookie-protocol/model.js';

function permutations(values) {
    return values.length
        ? values.flatMap((value, index) =>
              permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest])
          )
        : [[]];
}
let model, clock;
const login = (ticket, cookie = '', options = {}) =>
    model.login({ ticket, cookie, password: 'synthetic-password', ...options });
const header = (response) => response.setCookie.split(';')[0];
beforeEach(() => {
    clock = 10_000;
    model = new SessionCookieModel({ now: () => clock });
});
afterEach(() => model.close());

describe('offline revocable session and unique cookie protocol', () => {
    it.each(permutations(['login', 'renew', 'logout']).map((order) => [order.join(','), order]))(
        'denies old credentials after logout for delivery order %s',
        (_name, order) => {
            const ticket = model.issueTicket();
            const responses = { login: login(ticket) };
            responses.renew = model.renew(header(responses.login));
            responses.logout = model.logout({ tickets: [ticket] });
            const jar = new Map();
            for (const key of order) applyFixtureCookie(jar, responses[key]);
            expect(model.authenticate(fixtureCookieHeader(jar)).authenticated).toBe(false);
            expect(model.authenticate(header(responses.login)).authenticated).toBe(false);
            expect(() => model.renew(header(responses.renew))).toThrow('session_invalid');
        }
    );
    it.each(
        permutations(['login', 'renew', 'logout', 'newLogin']).map((order) => [
            order.join(','),
            order,
        ])
    )(
        'preserves new login without reviving old credentials for delivery order %s',
        (_name, order) => {
            const ticket = model.issueTicket();
            const responses = { login: login(ticket) };
            responses.renew = model.renew(header(responses.login));
            responses.logout = model.logout({ tickets: [ticket] });
            responses.newLogin = login(model.issueTicket());
            const jar = new Map();
            for (const key of order) applyFixtureCookie(jar, responses[key]);
            expect(model.authenticate(fixtureCookieHeader(jar)).ids).toEqual([
                responses.newLogin.id,
            ]);
            expect(model.authenticate(header(responses.login)).authenticated).toBe(false);
        }
    );
    it('cancels a ticket before password processing and never admits its delayed login', () => {
        const ticket = model.issueTicket();
        model.logout({ tickets: [ticket] });
        expect(() => login(ticket)).toThrow('login_cancelled');
        expect(model.sql.prepare('SELECT count(*) AS n FROM sessions').get().n).toBe(0);
    });
    it('revokes the actual current session with its cookie even after ticket acknowledgement', () => {
        const ticket = model.issueTicket(),
            response = login(ticket),
            cookie = header(response);
        expect(model.acknowledge(ticket, cookie)).toBe(true);
        expect(model.authenticate(cookie).authenticated).toBe(true);
        model.logout({ cookie, ids: [response.id] });
        expect(model.authenticate(cookie).authenticated).toBe(false);
        const retry = login(ticket);
        expect(retry).toMatchObject({ committed: true, active: false, setCookie: null });
    });
    it('makes repeated logout and lost-response retries target only captured operations', () => {
        const ticket = model.issueTicket(),
            old = login(ticket);
        const captured = { tickets: [ticket], ids: [old.id], cookie: header(old) };
        model.logout(captured);
        const next = login(model.issueTicket());
        model.logout({ ...captured, cookie: `${header(old)}; ${header(next)}` });
        expect(model.authenticate(header(next)).authenticated).toBe(true);
        expect(model.authenticate(header(old)).authenticated).toBe(false);
    });
    it('does not reconstruct a secret from a committed login receipt after a lost response', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        const retry = login(ticket);
        expect(retry).toEqual({
            success: true,
            committed: true,
            active: true,
            id: response.id,
            setCookie: null,
        });
        expect(model.acknowledge(ticket, '')).toBe(false);
        model.logout({ tickets: [ticket] });
        expect(() => login(ticket)).toThrow('login_cancelled');
        expect(model.authenticate(header(login(model.issueTicket()))).authenticated).toBe(true);
    });
    it('invalid password, guessed cancellation proof and ticket metadata cannot authenticate or revoke', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        expect(() => model.login({ ticket, password: 'wrong' })).toThrow('wrong_password');
        expect(() => model.logout({ tickets: [{ ...ticket, cancelToken: 'guess' }] })).toThrow(
            'invalid_cancel_proof'
        );
        expect(model.authenticate(`scope=${ticket.id}`).authenticated).toBe(false);
        expect(model.authenticate(header(response).replace(/=.*/, '=guess')).authenticated).toBe(
            false
        );
        expect(model.authenticate(header(response)).authenticated).toBe(true);
    });
    it('validates all cancellation proofs before revoking any target', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        const other = model.issueTicket();
        expect(() =>
            model.logout({
                cookie: header(response),
                tickets: [ticket, { ...other, cancelToken: 'wrong' }],
            })
        ).toThrow();
        expect(model.authenticate(header(response)).authenticated).toBe(true);
        expect(model.ticket(ticket).state).toBe('committed');
    });
    it('does not fall back when the store is unavailable and retries an uncommitted logout', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        model.unavailable = true;
        expect(() => model.authenticate(header(response))).toThrow('session_store_unavailable');
        expect(() => model.logout({ tickets: [ticket] })).toThrow('session_store_unavailable');
        model.unavailable = false;
        expect(model.authenticate(header(response)).authenticated).toBe(true);
        model.logout({ tickets: [ticket] });
        expect(model.authenticate(header(response)).authenticated).toBe(false);
    });
    it('rolls back every revocation and ticket cancellation when commit fails', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        model.failBeforeCommit = true;
        expect(() => model.logout({ tickets: [ticket] })).toThrow('fixture_transaction_failure');
        model.failBeforeCommit = false;
        expect(model.ticket(ticket).state).toBe('committed');
        expect(model.authenticate(header(response)).authenticated).toBe(true);
        model.logout({ tickets: [ticket] });
        expect(model.authenticate(header(response)).authenticated).toBe(false);
    });
    it('does not revive a cancelled or expired ticket after tombstone pruning', () => {
        const ticket = model.issueTicket();
        model.logout({ tickets: [ticket] });
        clock = ticket.deadline + 1;
        model.sql.prepare('DELETE FROM tickets WHERE id=?').run(ticket.id);
        expect(() => login(ticket)).toThrow('unknown_ticket');
        const expired = model.issueTicket();
        clock = expired.deadline + 1;
        expect(() => login(expired)).toThrow('ticket_expired');
    });
    it('expires credentials independently of the browser and never accepts renewed revoked credentials', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        clock += model.sessionTtl + 1;
        expect(model.authenticate(header(response)).authenticated).toBe(false);
        expect(() => model.renew(header(response))).toThrow('session_invalid');
    });
    it('rotates credentials at login and rejects copied previous credentials', () => {
        const old = login(model.issueTicket()),
            next = login(model.issueTicket(), header(old), { priorIds: [old.id] });
        expect(next.id).not.toBe(old.id);
        expect(model.authenticate(header(old)).authenticated).toBe(false);
        expect(model.authenticate(header(next)).authenticated).toBe(true);
    });
    it('delayed cleanup only deletes a permanently invalid old SID', () => {
        const old = login(model.issueTicket());
        expect(() => model.cleanup(header(old), old.id)).toThrow('session_still_active');
        model.logout({ cookie: header(old), ids: [old.id] });
        const cleanup = model.cleanup(header(old), old.id),
            next = login(model.issueTicket());
        const jar = new Map();
        applyFixtureCookie(jar, next);
        applyFixtureCookie(jar, old);
        applyFixtureCookie(jar, cleanup);
        expect(model.authenticate(fixtureCookieHeader(jar)).ids).toEqual([next.id]);
    });
    it('bounds and rejects ambiguous cookie input instead of choosing by header order', () => {
        const response = login(model.issueTicket()),
            cookie = header(response);
        expect(() => model.authenticate(`${cookie}; ${cookie}`)).toThrow('ambiguous_cookie');
        expect(() => model.authenticate('x'.repeat(4097))).toThrow('cookie_limit');
        expect(() =>
            model.authenticate(
                Array.from({ length: 9 }, (_, i) => `__Host-misub_sid_s${i}=a`).join('; ')
            )
        ).toThrow('cookie_limit');
    });
    it('stores only digests, never password or raw session/cancellation secrets', () => {
        const ticket = model.issueTicket();
        login(ticket);
        const rows = JSON.stringify([
            model.sql.prepare('SELECT * FROM tickets').all(),
            model.sql.prepare('SELECT * FROM sessions').all(),
        ]);
        expect(rows).not.toContain('synthetic-password');
        expect(rows).not.toContain('fixture-secret');
        expect(rows).not.toContain('fixture-cancel');
    });
    it.each([false, true])(
        'a successful new login cancels captured earlier pending ticket (committed=%s)',
        (committed) => {
            const oldTicket = model.issueTicket();
            const old = committed ? login(oldTicket) : null;
            const next = login(model.issueTicket(), '', { priorTickets: [oldTicket] });
            expect(() => login(oldTicket)).toThrow('login_cancelled');
            if (old) expect(model.authenticate(header(old)).authenticated).toBe(false);
            expect(model.authenticate(header(next)).authenticated).toBe(true);
        }
    );
    it('keeps cancellation proof valid after redemption deadline while its session is active', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        clock = ticket.deadline + 1;
        expect(model.authenticate(header(response)).authenticated).toBe(true);
        model.logout({ tickets: [ticket] });
        expect(model.authenticate(header(response)).authenticated).toBe(false);
    });
    it('ignores future cookies automatically attached to an older logout request', () => {
        const old = login(model.issueTicket()),
            next = login(model.issueTicket());
        model.logout({ ids: [old.id], cookie: `${header(old)}; ${header(next)}` });
        expect(model.authenticate(header(old)).authenticated).toBe(false);
        expect(model.authenticate(header(next)).authenticated).toBe(true);
    });
    it('refuses to acknowledge revocation of an active target without a matching proof', () => {
        const old = login(model.issueTicket());
        expect(() => model.logout({ ids: [old.id] })).toThrow('session_proof_required');
        expect(() => login(model.issueTicket(), '', { priorIds: [old.id] })).toThrow(
            'session_proof_required'
        );
        expect(model.authenticate(header(old)).authenticated).toBe(true);
    });
    it('rolls back mixed proved and unproved target sets', () => {
        const first = login(model.issueTicket()),
            second = login(model.issueTicket());
        expect(() => model.logout({ ids: [first.id, second.id], cookie: header(first) })).toThrow(
            'session_proof_required'
        );
        expect(model.authenticate(`${header(first)}; ${header(second)}`).ids).toEqual([
            first.id,
            second.id,
        ]);
    });
    it('accepts the matching cancellation proof for an unreceived target credential', () => {
        const ticket = model.issueTicket(),
            response = login(ticket);
        model.logout({ ids: [response.id], tickets: [ticket] });
        expect(model.authenticate(header(response)).authenticated).toBe(false);
    });
    it('recovers nine accumulated cookies without deleting the active credential', () => {
        const jar = new Map();
        let previous;
        for (let index = 0; index < 9; index++) {
            const response = login(model.issueTicket(), fixtureCookieHeader(jar), {
                priorIds: previous ? [previous.id] : [],
            });
            applyFixtureCookie(jar, response);
            previous = response;
        }
        expect(() => model.authenticate(fixtureCookieHeader(jar))).toThrow('cookie_limit');
        const { staleIds } = model.maintenance(fixtureCookieHeader(jar));
        expect(staleIds).toHaveLength(8);
        for (const id of staleIds)
            applyFixtureCookie(jar, model.cleanup(fixtureCookieHeader(jar), id));
        expect(model.authenticate(fixtureCookieHeader(jar)).ids).toEqual([previous.id]);
        expect(() => model.cleanup('oversized'.repeat(4096), previous.id)).toThrow(
            'session_still_active'
        );
    });
    it('bounds maintenance separately and allows explicit stale SID cleanup above its header limit', () => {
        const stale = '__Host-misub_sid_s999=fixture';
        expect(model.maintenance(stale).staleIds).toEqual(['s999']);
        expect(() => model.maintenance(`${stale}; ${stale}`)).toThrow('ambiguous_cookie');
        expect(() => model.maintenance('x'.repeat(16385))).toThrow('cookie_limit');
        expect(() =>
            model.maintenance(
                Array.from({ length: 33 }, (_, i) => `__Host-misub_sid_s${i}=a`).join('; ')
            )
        ).toThrow('cookie_limit');
        expect(model.cleanup('x'.repeat(16385), 's999').setCookie).toContain('Max-Age=0');
    });
    it('maintenance treats wrong secrets on active SID names as active and never deletes them', () => {
        const response = login(model.issueTicket());
        expect(model.maintenance(header(response).replace(/=.*/, '=wrong')).staleIds).toEqual([]);
        expect(() => model.cleanup('', response.id)).toThrow('session_still_active');
    });
});
