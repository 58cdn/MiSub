import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Offline protocol model. Fixture identifiers and secrets are deliberately predictable.
// This module has no imports from the application and is not a production session issuer.
const PREFIX = '__Host-misub_sid_';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code) => Object.assign(new Error(code), { status, code });

export class SessionCookieModel {
    constructor({ now = () => Date.now(), ticketTtl = 60_000, sessionTtl = 300_000 } = {}) {
        this.now = now;
        this.ticketTtl = ticketTtl;
        this.sessionTtl = sessionTtl;
        this.serial = 0;
        this.unavailable = false;
        this.failBeforeCommit = false;
        this.sql = new DatabaseSync(':memory:');
        this.sql.exec(`
            CREATE TABLE tickets(id TEXT PRIMARY KEY, cancel_hash TEXT NOT NULL,
                deadline INTEGER NOT NULL, state TEXT NOT NULL, sid TEXT);
            CREATE TABLE sessions(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
                expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        `);
    }

    check() {
        if (this.unavailable) throw fail(503, 'session_store_unavailable');
    }
    transaction(action) {
        this.check();
        this.sql.exec('BEGIN IMMEDIATE');
        try {
            const value = action();
            if (this.failBeforeCommit) throw fail(503, 'fixture_transaction_failure');
            this.sql.exec('COMMIT');
            return value;
        } catch (error) {
            this.sql.exec('ROLLBACK');
            throw error;
        }
    }
    issueTicket() {
        return this.transaction(() => {
            const id = `ticket${++this.serial}`;
            const cancelToken = `fixture-cancel-${this.serial}`;
            const deadline = this.now() + this.ticketTtl;
            this.sql
                .prepare('INSERT INTO tickets VALUES(?,?,?,?,NULL)')
                .run(id, hash(cancelToken), deadline, 'pending');
            return { id, cancelToken, deadline };
        });
    }
    ticket(proof) {
        if (!proof || typeof proof.id !== 'string' || typeof proof.cancelToken !== 'string')
            throw fail(400, 'invalid_ticket');
        const row = this.sql.prepare('SELECT * FROM tickets WHERE id=?').get(proof.id);
        if (!row) throw fail(409, 'unknown_ticket');
        if (row.cancel_hash !== hash(proof.cancelToken)) throw fail(403, 'invalid_cancel_proof');
        return row;
    }
    candidates(cookie = '', { maxBytes = 4096, maxCandidates = 8 } = {}) {
        if (typeof cookie !== 'string' || Buffer.byteLength(cookie) > maxBytes)
            throw fail(431, 'cookie_limit');
        const values = cookie
            .split(';')
            .map((value) => value.trim())
            .filter((value) => value.startsWith(PREFIX));
        if (values.length > maxCandidates) throw fail(431, 'cookie_limit');
        const seen = new Set();
        return values.map((value) => {
            const match = /^(__Host-misub_sid_(s\d+))=([a-zA-Z0-9_-]+)$/.exec(value);
            if (!match || seen.has(match[1])) throw fail(400, 'ambiguous_cookie');
            seen.add(match[1]);
            return { name: match[1], id: match[2], secret: match[3] };
        });
    }
    validCandidates(cookie) {
        return this.candidates(cookie).flatMap((candidate) => {
            const row = this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(candidate.id);
            return row &&
                !row.revoked &&
                row.expires > this.now() &&
                row.secret_hash === hash(candidate.secret)
                ? [{ ...candidate, expires: row.expires }]
                : [];
        });
    }
    revocationTargets(ids, cookie, tickets = []) {
        if (
            !Array.isArray(ids) ||
            ids.length > 8 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => typeof id !== 'string' || !/^s\d+$/.test(id))
        )
            throw fail(400, 'invalid_targets');
        const proven = new Set([
            ...this.validCandidates(cookie).map((item) => item.id),
            ...tickets.map((item) => item.sid),
        ]);
        return ids.filter((id) => {
            const row = this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(id);
            if (!row || row.revoked || row.expires <= this.now()) return false;
            if (!proven.has(id)) throw fail(403, 'session_proof_required');
            return true;
        });
    }
    cookie(id, secret) {
        return `${PREFIX}${id}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(this.sessionTtl / 1000)}`;
    }
    login({ ticket, password, cookie = '', priorIds = [], priorTickets = [] }) {
        this.check();
        if (password !== 'synthetic-password') throw fail(401, 'wrong_password');
        return this.transaction(() => {
            const row = this.ticket(ticket);
            if (row.state === 'cancelled') throw fail(409, 'login_cancelled');
            if (row.state === 'committed') {
                const session = this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(row.sid);
                return {
                    success: true,
                    committed: true,
                    active: !session.revoked && session.expires > this.now(),
                    id: row.sid,
                    setCookie: null,
                };
            }
            if (row.deadline <= this.now()) throw fail(409, 'ticket_expired');
            if (
                !Array.isArray(priorIds) ||
                priorIds.length > 8 ||
                !Array.isArray(priorTickets) ||
                priorTickets.length > 16
            )
                throw fail(400, 'target_limit');
            const replaced = priorTickets.map((proof) => this.ticket(proof));
            if (replaced.some((item) => item.id === row.id)) throw fail(400, 'self_replacement');
            const previous = this.revocationTargets(priorIds, cookie, replaced);
            const id = `s${++this.serial}`,
                secret = `fixture-secret-${this.serial}`;
            this.sql
                .prepare('INSERT INTO sessions VALUES(?,?,?,0)')
                .run(id, hash(secret), this.now() + this.sessionTtl);
            this.sql
                .prepare("UPDATE tickets SET state='committed',sid=? WHERE id=?")
                .run(id, row.id);
            for (const id of previous)
                this.sql.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(id);
            for (const item of replaced) {
                this.sql.prepare("UPDATE tickets SET state='cancelled' WHERE id=?").run(item.id);
                if (item.sid)
                    this.sql.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(item.sid);
            }
            return {
                success: true,
                committed: true,
                active: true,
                id,
                setCookie: this.cookie(id, secret),
            };
        });
    }
    logout({ tickets = [], ids = [], cookie = '' } = {}) {
        if (!Array.isArray(tickets) || tickets.length > 16 || !Array.isArray(ids) || ids.length > 8)
            throw fail(400, 'target_limit');
        return this.transaction(() => {
            // Validate every target before applying any cancellation.
            const rows = tickets.map((proof) => this.ticket(proof));
            const sessions = this.revocationTargets(ids, cookie, rows);
            for (const row of rows) {
                this.sql.prepare("UPDATE tickets SET state='cancelled' WHERE id=?").run(row.id);
                if (row.sid)
                    this.sql.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(row.sid);
            }
            for (const id of sessions)
                this.sql.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(id);
            return { success: true, setCookie: null };
        });
    }
    authenticate(cookie = '') {
        this.check();
        const sessions = this.validCandidates(cookie);
        return { authenticated: sessions.length > 0, ids: sessions.map((item) => item.id) };
    }
    renew(cookie = '') {
        return this.transaction(() => {
            const session = this.validCandidates(cookie)[0];
            if (!session) throw fail(401, 'session_invalid');
            this.sql
                .prepare('UPDATE sessions SET expires=? WHERE id=? AND revoked=0')
                .run(this.now() + this.sessionTtl, session.id);
            return {
                success: true,
                id: session.id,
                setCookie: this.cookie(session.id, session.secret),
            };
        });
    }
    acknowledge(ticket, cookie = '') {
        this.check();
        const row = this.ticket(ticket);
        return (
            row.state === 'committed' &&
            this.validCandidates(cookie).some((item) => item.id === row.sid)
        );
    }
    maintenance(cookie = '') {
        this.check();
        // Recovery is separately bounded and does not use the authentication admission limit.
        const candidates = this.candidates(cookie, { maxBytes: 16384, maxCandidates: 32 });
        return {
            staleIds: candidates.flatMap(({ id }) => {
                const row = this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(id);
                return !row || row.revoked || row.expires <= this.now() ? [id] : [];
            }),
        };
    }
    cleanup(_cookie, id) {
        this.check();
        if (!/^s\d+$/.test(id)) throw fail(400, 'invalid_sid');
        // SID values are never reused. A delayed deletion can only target this old SID.
        const row = this.sql.prepare('SELECT * FROM sessions WHERE id=?').get(id);
        if (row && !row.revoked && row.expires > this.now())
            throw fail(409, 'session_still_active');
        return {
            setCookie: `${PREFIX}${id}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
        };
    }
    close() {
        this.sql.close();
    }
}

export function applyFixtureCookie(jar, response) {
    if (!response.setCookie) return;
    const [name, value] = response.setCookie.split(';')[0].split('=');
    if (!value) jar.delete(name);
    else jar.set(name, value);
}
export const fixtureCookieHeader = (jar) =>
    [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
