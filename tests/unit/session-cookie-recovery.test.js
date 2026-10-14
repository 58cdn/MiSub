// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCookieModel } from '../../experiments/session-cookie-protocol/model.js';

let model, now;
const cookie = (response) => response.setCookie.split(';')[0];
function pending() {
    const ticket = model.issueTicket();
    const login = model.login({ ticket, password: 'synthetic-password' });
    return { ticket, login, cookie: `${cookie(ticket)}; ${cookie(login)}` };
}
beforeEach(() => {
    now = 1000;
    model = new SessionCookieModel({ now: () => now });
});
afterEach(() => model.close());

describe('server recovery and activation boundary', () => {
    it('does not acknowledge an empty logout target while a real credential is active', () => {
        const session = pending();
        model.acknowledge(session.ticket, session.cookie);
        expect(() => model.revokeTargets({ cookie: session.cookie })).toThrow(
            'logout_recovery_required'
        );
        const snapshot = model.captureRecovery(session.cookie);
        expect(model.logoutRecovered(snapshot).success).toBe(true);
        expect(model.authenticate(session.cookie).authenticated).toBe(false);
    });
    it('recovers a login whose SID response has not arrived using only its operation cookie', () => {
        const session = pending();
        const snapshot = model.captureRecovery(cookie(session.ticket));
        model.logoutRecovered(snapshot);
        expect(model.acknowledge(session.ticket, session.cookie)).toBe(false);
        expect(model.authenticate(session.cookie).authenticated).toBe(false);
    });
    it.each(['confirm-first', 'logout-first'])(
        'revokes pending SID with no operation cookie: %s',
        (order) => {
            const session = pending();
            const snapshot = model.captureRecovery(cookie(session.login));
            if (order === 'confirm-first')
                expect(model.acknowledge(session.ticket, session.cookie)).toBe(true);
            model.logoutRecovered(snapshot);
            expect(model.acknowledge(session.ticket, session.cookie)).toBe(false);
            expect(model.authenticate(session.cookie).authenticated).toBe(false);
        }
    );
    it('does not activate a delayed SID when every local cancellation proof has been lost', () => {
        const session = pending();
        expect(model.authenticate(cookie(session.login)).authenticated).toBe(false);
        expect(() => model.renew(cookie(session.login))).toThrow('session_invalid');
        const snapshot = model.captureRecovery(cookie(session.login));
        expect(snapshot).not.toHaveProperty('cancelToken');
        expect(snapshot).not.toHaveProperty('ticket');
        expect(() => model.acknowledge(snapshot, cookie(session.login))).toThrow('invalid_ticket');
        model.logoutRecovered(snapshot);
        expect(model.acknowledge(session.ticket, session.cookie)).toBe(false);
    });
    it('never treats absence of recoverable evidence as a confirmed logout', () => {
        expect(() => model.captureRecovery('')).toThrow('logout_recovery_unconfirmed');
        expect(() => model.revokeTargets()).toThrow('logout_recovery_required');
    });
    it('requires proof and persists only hashes and fixed public targets', () => {
        const session = pending(),
            snapshot = model.captureRecovery(session.cookie);
        expect(() => model.logoutRecovered({ ...snapshot, proof: 'wrong' })).toThrow(
            'invalid_recovery_proof'
        );
        const serialized = JSON.stringify(
            model.sql.prepare('SELECT * FROM logout_snapshots').all()
        );
        expect(serialized).not.toContain(snapshot.proof);
        expect(serialized).not.toContain(session.ticket.cancelToken);
        expect(serialized).not.toContain('fixture-secret');
    });
    it('retries the fixed snapshot without revoking a new login or expanding its targets', () => {
        const old = pending(),
            snapshot = model.captureRecovery(old.cookie);
        model.logoutRecovered(snapshot);
        const next = pending();
        model.acknowledge(next.ticket, next.cookie);
        expect(
            model.logoutRecovered({ ...snapshot, cookie: next.cookie, ids: [next.login.id] })
                .success
        ).toBe(true);
        expect(model.authenticate(next.cookie).authenticated).toBe(true);
    });
    it('rolls back pending, active and ticket revocation together and permits a 503 retry', () => {
        const first = pending(),
            second = pending();
        model.acknowledge(first.ticket, first.cookie);
        const snapshot = model.captureRecovery(`${first.cookie}; ${second.cookie}`);
        model.failBeforeCommit = true;
        expect(() => model.logoutRecovered(snapshot)).toThrow('fixture_transaction_failure');
        model.failBeforeCommit = false;
        expect(model.authenticate(first.cookie).authenticated).toBe(true);
        expect(model.acknowledge(second.ticket, second.cookie)).toBe(true);
        model.logoutRecovered(snapshot);
        expect(model.authenticate(`${first.cookie}; ${second.cookie}`).authenticated).toBe(false);
    });
    it('rejects store failure and never falls back to unsigned recovery metadata', () => {
        const session = pending();
        model.unavailable = true;
        expect(() => model.captureRecovery(session.cookie)).toThrow('session_store_unavailable');
        expect(() => model.logoutRecovered({ id: 'x', proof: 'x' })).toThrow(
            'session_store_unavailable'
        );
    });
    it('never deletes a pending SID or cancellation cookie which can still be confirmed', () => {
        const session = pending();
        expect(() => model.cleanup('', session.login.id)).toThrow('session_still_active');
        expect(() => model.cleanupTicket(session.ticket.id)).toThrow('ticket_still_active');
    });
    it('expires unconfirmed credentials and bounds renewal by the absolute lifetime without Set-Cookie', () => {
        const expired = pending();
        now += model.ticketTtl + 1;
        expect(model.acknowledge(expired.ticket, expired.cookie)).toBe(false);
        const session = pending(),
            absolute = now + model.absoluteTtl;
        expect(model.acknowledge(session.ticket, session.cookie)).toBe(true);
        while (now + 100_000 < absolute) {
            now += 100_000;
            expect(model.renew(session.cookie).setCookie).toBeNull();
        }
        now = absolute;
        expect(model.authenticate(session.cookie).authenticated).toBe(false);
        expect(() => model.renew(session.cookie)).toThrow('session_invalid');
    });
    it('rejects duplicate operation cookies and guessed cancellation cookies', () => {
        const session = pending(),
            op = cookie(session.ticket);
        expect(() => model.captureRecovery(`${op}; ${op}`)).toThrow('ambiguous_cookie');
        expect(() => model.captureRecovery(op.replace(/=.*/, '=wrong'))).toThrow(
            'logout_recovery_unconfirmed'
        );
    });
    it('includes local cancellation proofs when a pending confirm lost its Cookie', () => {
        const first = pending(),
            second = pending();
        model.acknowledge(first.ticket, first.cookie);
        const snapshot = model.captureRecovery(first.cookie, { tickets: [second.ticket] });
        model.logoutRecovered(snapshot);
        expect(model.acknowledge(second.ticket, second.cookie)).toBe(false);
        expect(model.authenticate(first.cookie).authenticated).toBe(false);
    });
    it('refuses partial recovery if a known live SID lacks both forms of proof', () => {
        const first = pending(),
            second = pending();
        model.acknowledge(first.ticket, first.cookie);
        expect(() => model.captureRecovery(second.cookie, { ids: [first.login.id] })).toThrow(
            'session_proof_required'
        );
        expect(model.authenticate(first.cookie).authenticated).toBe(true);
    });
    it.each([true, false])(
        'retries a fixed recovery after the retention deadline (completed=%s)',
        (completed) => {
            const session = pending(),
                snapshot = model.captureRecovery(session.cookie);
            if (completed) model.logoutRecovered(snapshot);
            now += model.absoluteTtl + model.ticketTtl + 1;
            expect(model.logoutRecovered(snapshot).success).toBe(true);
            expect(model.acknowledge(session.ticket, session.cookie)).toBe(false);
        }
    );
    it('cleans unknown expired operation Cookies in bounded pages beyond normal recovery limits', () => {
        const cookies = Array.from({ length: 33 }, () => cookie(model.issueTicket()));
        now += model.ticketTtl + 1;
        const first = model.maintenance(cookies.join('; '));
        expect(first.staleTicketIds).toHaveLength(32);
        const remaining = cookies.filter(
            (value) => !first.staleTicketIds.some((id) => value.includes(`${id}=`))
        );
        for (const id of first.staleTicketIds)
            expect(model.cleanupTicket(id).setCookie).toContain('Max-Age=0');
        expect(model.maintenance(remaining.join('; ')).staleTicketIds).toHaveLength(1);
    });
    it('reports an inactive receipt after its session record has been collected', () => {
        const session = pending();
        model.sql.prepare('DELETE FROM sessions WHERE id=?').run(session.login.id);
        expect(
            model.login({ ticket: session.ticket, password: 'synthetic-password' })
        ).toMatchObject({ committed: true, active: false, setCookie: null });
    });
    it('recovers nine live SID cookies above the ordinary authentication admission limit', () => {
        const sessions = Array.from({ length: 9 }, () => pending());
        for (const session of sessions) model.acknowledge(session.ticket, session.cookie);
        const cookies = sessions.map((session) => session.cookie).join('; ');
        expect(model.maintenance(cookies).staleIds).toHaveLength(0);
        expect(() => model.authenticate(cookies)).toThrow('cookie_limit');
        const snapshot = model.captureRecovery(cookies, { ids: [sessions[0].login.id] });
        expect(snapshot.ids).toHaveLength(9);
        expect(model.logoutRecovered(snapshot).success).toBe(true);
        for (const session of sessions)
            expect(model.authenticate(session.cookie).authenticated).toBe(false);
    });
});
