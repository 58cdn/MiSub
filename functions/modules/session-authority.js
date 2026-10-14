import { D1SessionState, SessionStateUnavailable } from './session-state.js';
import { SESSION_DURATION, SESSION_RENEW_THRESHOLD } from './config.js';

const SID = '__Host-misub_sid_';
const OP = '__Host-misub_op_';
const ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const TICKET_TTL = 120_000;
const ABSOLUTE_TTL = 90 * 24 * 60 * 60 * 1000;
const CAPTURE_WINDOW = 300_000;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const random = (size) => hex(crypto.getRandomValues(new Uint8Array(size)));
const hash = async (value) =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
const bytes = (value) => Uint8Array.from(value.match(/.{2}/g), (part) => parseInt(part, 16));
const receiptKey = (key) =>
    crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
    ]);
async function signReceipt(state, id, snapshot) {
    const payload = JSON.stringify({
        version: 1,
        id,
        proofHash: snapshot.proofHash,
        ids: snapshot.ids,
        tickets: snapshot.tickets,
        expires: snapshot.receiptExpires,
    });
    const signature = hex(
        new Uint8Array(
            await crypto.subtle.sign(
                'HMAC',
                await receiptKey(state.receiptKey),
                new TextEncoder().encode(payload)
            )
        )
    );
    return { payload, signature };
}
async function verifyReceipt(state, receipt) {
    if (
        !receipt ||
        typeof receipt.payload !== 'string' ||
        receipt.payload.length > 12000 ||
        typeof receipt.signature !== 'string' ||
        !SECRET.test(receipt.signature) ||
        !(await crypto.subtle.verify(
            'HMAC',
            await receiptKey(state.receiptKey),
            bytes(receipt.signature),
            new TextEncoder().encode(receipt.payload)
        ))
    )
        throw fail(403, 'invalid_recovery_receipt');
    let decoded;
    try {
        decoded = JSON.parse(receipt.payload);
    } catch {
        throw fail(403, 'invalid_recovery_receipt');
    }
    if (
        decoded?.version !== 1 ||
        !ID.test(decoded.id) ||
        !SECRET.test(decoded.proofHash) ||
        !Number.isSafeInteger(decoded.expires) ||
        decoded.expires <= 0
    )
        throw fail(403, 'invalid_recovery_receipt');
    targetIds(decoded.ids);
    if (
        !Array.isArray(decoded.tickets) ||
        decoded.tickets.length > 64 ||
        decoded.tickets.some((id) => !ID.test(id))
    )
        throw fail(403, 'invalid_recovery_receipt');
    return decoded;
}
const live = (s, now) => !!s && !s.revoked && s.expires > now && s.absoluteExpires > now;
const cookie = (prefix, id, value, seconds) =>
    `${prefix}${id}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;

export function sessionProtocol(env) {
    const mode = env?.SESSION_AUTH_MODE;
    if (mode === undefined || mode === '') return 'legacy';
    if (mode !== 'd1-v1') throw new SessionStateUnavailable('session_configuration_invalid');
    return 'd1-v1';
}

function parseCookies(header = '', { maxSessions = 8, maxOperations = 32 } = {}) {
    if (typeof header !== 'string' || new TextEncoder().encode(header).length > 16384)
        throw fail(431, 'cookie_limit');
    const sessions = [],
        operations = [],
        seen = new Set();
    for (const entry of header.split(';').map((part) => part.trim())) {
        const prefix = entry.startsWith(SID) ? SID : entry.startsWith(OP) ? OP : null;
        if (!prefix) continue;
        const parts = entry.slice(prefix.length).split('=');
        if (
            parts.length !== 2 ||
            !ID.test(parts[0]) ||
            !SECRET.test(parts[1]) ||
            seen.has(prefix + parts[0])
        )
            throw fail(400, 'ambiguous_cookie');
        seen.add(prefix + parts[0]);
        (prefix === SID ? sessions : operations).push({ id: parts[0], secret: parts[1] });
    }
    if (sessions.length > maxSessions || operations.length > maxOperations)
        throw fail(431, 'cookie_limit');
    return { sessions, operations };
}

function proof(value) {
    if (
        !value ||
        typeof value.id !== 'string' ||
        !ID.test(value.id) ||
        typeof value.cancelToken !== 'string' ||
        !SECRET.test(value.cancelToken)
    )
        throw fail(400, 'invalid_ticket');
    return value;
}
function targetIds(value = []) {
    if (
        !Array.isArray(value) ||
        value.length > 32 ||
        new Set(value).size !== value.length ||
        value.some((id) => typeof id !== 'string' || !ID.test(id))
    )
        throw fail(400, 'invalid_targets');
    return value;
}
function targetProofs(value = []) {
    if (!Array.isArray(value) || value.length > 32) throw fail(400, 'target_limit');
    return value.map(proof);
}

export class SessionAuthority {
    constructor(binding, { now = () => Date.now() } = {}) {
        this.store = new D1SessionState(binding);
        this.now = now;
    }
    async mutate(action) {
        return this.store.mutate(async (state) => {
            const now = this.now();
            for (const [id, s] of Object.entries(state.sessions))
                if (!live(s, now)) delete state.sessions[id];
            for (const [id, t] of Object.entries(state.tickets))
                if ((t.cancelled || t.deadline <= now) && !live(state.sessions[t.sid], now))
                    delete state.tickets[id];
            for (const [id, s] of Object.entries(state.snapshots))
                if (s.expires <= now) delete state.snapshots[id];
            return action(state, now);
        });
    }
    async ticket(state, value, { allowMissing = false } = {}) {
        proof(value);
        const row = state.tickets[value.id];
        if (!row) {
            if (allowMissing) return null;
            throw fail(409, 'ticket_expired');
        }
        if (row.cancelHash !== (await hash(value.cancelToken)))
            throw fail(403, 'invalid_cancel_proof');
        return row;
    }
    async proven(state, header, limits) {
        const parsed = parseCookies(header, limits);
        const sessions = [];
        for (const value of parsed.sessions) {
            const row = state.sessions[value.id];
            if (live(row, this.now()) && row.secretHash === (await hash(value.secret)))
                sessions.push({ id: value.id, ...row });
        }
        return { sessions, operations: parsed.operations };
    }
    async issueTicket() {
        const id = random(16),
            cancelToken = random(32),
            cancelHash = await hash(cancelToken);
        return this.mutate((state, now) => {
            if (Object.keys(state.tickets).length >= 128) throw fail(429, 'session_capacity');
            if (state.tickets[id]) throw new SessionStateUnavailable();
            const deadline = now + TICKET_TTL;
            state.tickets[id] = { cancelHash, deadline, sid: null, cancelled: false };
            return {
                ticket: { id, cancelToken, deadline },
                setCookies: [
                    cookie(OP, id, cancelToken, Math.ceil((ABSOLUTE_TTL + TICKET_TTL) / 1000)),
                ],
            };
        });
    }
    async login({ ticket, priorIds = [], priorTickets = [] }, header = '') {
        targetIds(priorIds);
        targetProofs(priorTickets);
        const id = random(16),
            secret = random(32),
            secretHash = await hash(secret);
        return this.mutate(async (state, now) => {
            const row = await this.ticket(state, ticket);
            if (row.cancelled) throw fail(409, 'login_cancelled');
            if (row.deadline <= now) throw fail(409, 'ticket_expired');
            if (row.sid)
                return {
                    success: true,
                    id: row.sid,
                    active: live(state.sessions[row.sid], now) && state.sessions[row.sid].active,
                    setCookies: [],
                };
            const replaced = [];
            for (const value of priorTickets) {
                if (value.id === ticket.id) throw fail(400, 'self_replacement');
                const old = await this.ticket(state, value, { allowMissing: true });
                if (old) replaced.push(old);
            }
            const presented = await this.proven(state, header, { maxSessions: 32 });
            const provenIds = new Set([
                ...presented.sessions.map((s) => s.id),
                ...replaced.map((t) => t.sid),
            ]);
            for (const oldId of priorIds)
                if (live(state.sessions[oldId], now) && !provenIds.has(oldId))
                    throw fail(403, 'session_proof_required');
            if (Object.keys(state.sessions).length >= 128) throw fail(429, 'session_capacity');
            if (state.sessions[id]) throw new SessionStateUnavailable();
            state.sessions[id] = {
                secretHash,
                expires: now + TICKET_TTL,
                absoluteExpires: now + ABSOLUTE_TTL,
                active: false,
                revoked: false,
                replaceIds: [...priorIds],
                replaceTickets: priorTickets.map((value) => value.id),
            };
            row.sid = id;
            return {
                success: true,
                id,
                active: false,
                setCookies: [cookie(SID, id, secret, ABSOLUTE_TTL / 1000)],
            };
        });
    }
    async confirm(ticket, header = '') {
        return this.mutate(async (state, now) => {
            const row = await this.ticket(state, ticket);
            const { sessions } = await this.proven(state, header);
            const session = sessions.find((s) => s.id === row.sid);
            if (row.cancelled || !session) throw fail(409, 'session_confirmation_failed');
            // Replace only the fixed, proven targets saved when this SID was prepared.
            // Confirmation proves the client received a Cookie after security admission.
            for (const id of session.replaceIds || [])
                if (state.sessions[id]) state.sessions[id].revoked = true;
            for (const id of session.replaceTickets || []) {
                const old = state.tickets[id];
                if (old) {
                    old.cancelled = true;
                    if (state.sessions[old.sid]) state.sessions[old.sid].revoked = true;
                }
            }
            delete state.sessions[row.sid].replaceIds;
            delete state.sessions[row.sid].replaceTickets;
            state.sessions[row.sid].active = true;
            state.sessions[row.sid].expires = Math.min(
                now + SESSION_DURATION,
                session.absoluteExpires
            );
            return { success: true, id: row.sid, setCookies: [] };
        });
    }
    async authenticate(header = '') {
        const { state } = await this.store.read();
        const { sessions } = await this.proven(state, header);
        const active = sessions.filter((s) => s.active);
        return {
            isAuthenticated: active.length > 0,
            ids: active.map((s) => s.id),
            shouldRenew: active.some(
                (s) => s.expires - this.now() <= SESSION_DURATION - SESSION_RENEW_THRESHOLD
            ),
        };
    }
    async renew(header = '') {
        return this.mutate(async (state, now) => {
            const { sessions } = await this.proven(state, header);
            for (const s of sessions)
                if (s.active)
                    state.sessions[s.id].expires = Math.min(
                        now + SESSION_DURATION,
                        s.absoluteExpires
                    );
            return { setCookies: [] };
        });
    }
    async capture({ recovery, ids = [], tickets = [] }, header = '') {
        targetIds(ids);
        targetProofs(tickets);
        if (
            !recovery ||
            !ID.test(recovery.id) ||
            !SECRET.test(recovery.proof) ||
            !Number.isSafeInteger(recovery.createdAt)
        )
            throw fail(400, 'invalid_recovery');
        const proofHash = await hash(recovery.proof);
        return this.mutate(async (state, now) => {
            const existing = state.snapshots[recovery.id];
            if (existing) {
                if (existing.proofHash !== proofHash || existing.createdAt !== recovery.createdAt)
                    throw fail(403, 'invalid_recovery_proof');
                return {
                    success: true,
                    id: recovery.id,
                    ids: existing.ids,
                    receipt: await signReceipt(state, recovery.id, existing),
                    setCookies: [],
                };
            }
            // Expired operation requests cannot recapture a newer browser session after GC.
            if (Math.abs(now - recovery.createdAt) > CAPTURE_WINDOW)
                throw fail(409, 'recovery_capture_expired');
            const presented = await this.proven(state, header, { maxSessions: 32 });
            const provenIds = new Set(presented.sessions.map((s) => s.id));
            const ticketIds = new Set();
            for (const value of tickets) {
                const row = await this.ticket(state, value, { allowMissing: true });
                if (row) {
                    ticketIds.add(value.id);
                    if (row.sid) provenIds.add(row.sid);
                }
            }
            for (const value of presented.operations) {
                const row = state.tickets[value.id];
                if (row && row.cancelHash === (await hash(value.secret))) ticketIds.add(value.id);
            }
            for (const id of ids)
                if (live(state.sessions[id], now) && !provenIds.has(id))
                    throw fail(403, 'session_proof_required');
            const targets = [
                ...new Set([
                    ...presented.sessions.map((s) => s.id),
                    ...ids.filter((id) => live(state.sessions[id], now)),
                ]),
            ];
            if (!targets.length && !ticketIds.size) {
                const error = fail(409, 'logout_recovery_unconfirmed');
                error.settled = { ids, tickets: tickets.map((t) => t.id) };
                throw error;
            }
            const snapshot = {
                proofHash,
                createdAt: recovery.createdAt,
                ids: targets,
                tickets: [...ticketIds],
                expires: Math.max(now, recovery.createdAt) + CAPTURE_WINDOW + 1000,
                receiptExpires: now + ABSOLUTE_TTL + TICKET_TTL,
                completed: false,
            };
            if (
                targets.length > 32 ||
                ticketIds.size > 64 ||
                Object.keys(state.snapshots).length >= 128
            )
                throw fail(429, 'session_capacity');
            state.snapshots[recovery.id] = snapshot;
            if (JSON.stringify(state).length > 240000) throw fail(429, 'session_capacity');
            return {
                success: true,
                id: recovery.id,
                ids: targets,
                receipt: await signReceipt(state, recovery.id, snapshot),
                setCookies: [],
            };
        });
    }
    async logout(recovery, receipt) {
        if (!recovery || !ID.test(recovery.id) || !SECRET.test(recovery.proof))
            throw fail(400, 'invalid_recovery');
        const proofHash = await hash(recovery.proof);
        return this.mutate(async (state, now) => {
            const snapshot = await verifyReceipt(state, receipt);
            if (snapshot.id !== recovery.id || snapshot.proofHash !== proofHash)
                throw fail(403, 'invalid_recovery_proof');
            if (snapshot.expires <= now) return { success: true, setCookies: [] };
            for (const id of snapshot.ids)
                if (state.sessions[id]) state.sessions[id].revoked = true;
            for (const id of snapshot.tickets) {
                const row = state.tickets[id];
                if (!row) continue;
                row.cancelled = true;
                if (state.sessions[row.sid]) state.sessions[row.sid].revoked = true;
            }
            return { success: true, setCookies: [] };
        });
    }
    async cleanup(header = '') {
        const { state } = await this.store.read();
        const parsed = parseCookies(header, { maxSessions: 256, maxOperations: 256 });
        const setCookies = [];
        for (const { id } of parsed.sessions)
            if (!live(state.sessions[id], this.now())) setCookies.push(cookie(SID, id, '', 0));
        for (const { id } of parsed.operations) {
            const row = state.tickets[id];
            if (
                !row ||
                row.cancelled ||
                (row.sid ? !live(state.sessions[row.sid], this.now()) : row.deadline <= this.now())
            )
                setCookies.push(cookie(OP, id, '', 0));
        }
        return { success: true, more: setCookies.length > 32, setCookies: setCookies.slice(0, 32) };
    }
}
