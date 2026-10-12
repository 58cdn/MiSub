import { digest, originTokenHash, randomToken, requireValue, probeError } from './probe-contract.js';
import { PAIRING_TTL_MS, pairingId, pairingCode, pairingStart, pairingToken, newPairingCodes, pairingFingerprint, pairingDeviceHash, samePairingHash, pairingRateLimit } from './probe-pairing.js';

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS probe_pairing_windows (id TEXT PRIMARY KEY, origin TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cancelled_at INTEGER, start_attempts INTEGER NOT NULL DEFAULT 0, resolve_attempts INTEGER NOT NULL DEFAULT 0, token_attempts INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS probe_pairings (id TEXT PRIMARY KEY, window_id TEXT NOT NULL REFERENCES probe_pairing_windows(id) ON DELETE CASCADE, name TEXT NOT NULL, version TEXT NOT NULL, platform TEXT NOT NULL, proof_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, device_hash TEXT NOT NULL, user_code_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, approved_at INTEGER, consumed_at INTEGER, agent_id TEXT, next_poll_at INTEGER NOT NULL, interval_seconds INTEGER NOT NULL DEFAULT 5, poll_count INTEGER NOT NULL DEFAULT 0, UNIQUE(window_id,user_code_hash))`,
    `CREATE INDEX IF NOT EXISTS probe_pairing_expiry ON probe_pairing_windows(expires_at)`,
    `CREATE INDEX IF NOT EXISTS probe_pairing_window ON probe_pairings(window_id)`,
    `CREATE TABLE IF NOT EXISTS probe_pairing_budget (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL DEFAULT -1, count INTEGER NOT NULL DEFAULT 0)`,
    ...['window', 'start', 'token', 'resolve'].map(key => `INSERT OR IGNORE INTO probe_pairing_budget(key) VALUES ('${key}')`)
];
const initialized = new WeakMap();
const REQUEST_SELECT = `SELECT p.*,w.origin,w.expires_at,w.cancelled_at,COALESCE(a.last_seen,0) AS last_seen
    FROM probe_pairings p JOIN probe_pairing_windows w ON w.id=p.window_id LEFT JOIN probe_agents a ON a.id=p.agent_id`;
function requestStatus(row, now) {
    if (row.state === 'consumed') return 'consumed';
    if (row.cancelled_at !== null || row.state === 'cancelled') return 'cancelled';
    return row.expires_at <= now ? 'expired' : row.state;
}
function publicPairing(row, now) {
    return { id: row.id, windowId: row.window_id, origin: row.origin, name: row.name, version: row.version, platform: row.platform,
        fingerprint: row.fingerprint, status: requestStatus(row, now), createdAt: row.created_at, expiresAt: row.expires_at,
        approvedAt: row.approved_at, consumedAt: row.consumed_at, agentId: row.agent_id, lastSeen: row.last_seen, checkedAt: now };
}

export class ProbePairingStore {
    constructor(db, now = Date.now) { this.db = db; this.now = now; }
    q(sql, ...params) { requireValue(this.db, 'probe_storage_not_configured', 503); return this.db.prepare(sql).bind(...params); }
    async init() {
        requireValue(this.db, 'probe_storage_not_configured', 503);
        if (!initialized.has(this.db)) initialized.set(this.db, this.db.batch(SCHEMA.map(sql => this.db.prepare(sql))).catch(error => { initialized.delete(this.db); throw error; }));
        await initialized.get(this.db);
    }
    async budget(key, max, period = 60000) {
        const now = this.now(); const bucket = Math.floor(now / period);
        const taken = await this.q(`UPDATE probe_pairing_budget SET bucket=?,count=CASE WHEN bucket=? THEN count+1 ELSE 1 END
            WHERE key=? AND (bucket<>? OR count<?) RETURNING key`, bucket, bucket, key, bucket, max).first();
        if (!taken) throw pairingRateLimit(((bucket + 1) * period - now) / 1000);
    }
    async windowBudget(id, origin, field, max, active = true) {
        const columns = { start: 'start_attempts', resolve: 'resolve_attempts', token: 'token_attempts' };
        const column = columns[field];
        requireValue(column, 'invalid_pairing_request');
        const now = this.now();
        const row = await this.q(`UPDATE probe_pairing_windows SET ${column}=${column}+1 WHERE id=? AND origin=? AND ${column}<?
            AND (?=0 OR (cancelled_at IS NULL AND expires_at>?)) RETURNING id`, id, origin, max, active ? 1 : 0, now).first();
        if (row) return;
        const window = await this.q('SELECT expires_at,cancelled_at FROM probe_pairing_windows WHERE id=? AND origin=?', id, origin).first();
        requireValue(window && (!active || (window.cancelled_at === null && window.expires_at > now)), 'pairing_unavailable', 404);
        throw pairingRateLimit((window.expires_at - now) / 1000);
    }
    async createWindow(origin) {
        await this.init();
        await this.budget('window', 12, 3600000);
        const now = this.now(); const id = crypto.randomUUID();
        await this.q('DELETE FROM probe_pairing_windows WHERE id IN (SELECT id FROM probe_pairing_windows WHERE expires_at<? ORDER BY expires_at LIMIT 100)', now - 86400000).run();
        const result = await this.q(`INSERT INTO probe_pairing_windows(id,origin,created_at,expires_at)
            SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM probe_pairing_windows WHERE cancelled_at IS NULL AND expires_at>?)<4`, id, origin, now, now + PAIRING_TTL_MS, now).run();
        if (!result.meta.changes) throw pairingRateLimit(300);
        return this.window(id, origin);
    }
    async window(id, origin) {
        pairingId(id);
        const row = await this.q('SELECT id,origin,created_at,expires_at,cancelled_at FROM probe_pairing_windows WHERE id=? AND origin=?', id, origin).first();
        requireValue(row, 'pairing_unavailable', 404);
        const records = await this.q(`${REQUEST_SELECT} WHERE p.window_id=? ORDER BY p.created_at,p.id LIMIT 3`, id).all();
        const now = this.now();
        return { id: row.id, origin: row.origin, status: row.cancelled_at !== null ? 'cancelled' : row.expires_at <= now ? 'expired' : 'open',
            createdAt: row.created_at, expiresAt: row.expires_at, checkedAt: now, requests: records.results.map(record => publicPairing(record, now)) };
    }
    async cancelWindow(id, origin) {
        pairingId(id);
        const result = await this.db.batch([
            this.q('UPDATE probe_pairing_windows SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=? AND origin=?', this.now(), id, origin),
            this.q(`UPDATE probe_pairings SET state='cancelled' WHERE window_id=? AND state IN ('pending','approved')
                AND EXISTS(SELECT 1 FROM probe_pairing_windows WHERE id=? AND origin=? AND cancelled_at IS NOT NULL)`, id, id, origin)
        ]);
        requireValue(result[0].meta.changes > 0, 'pairing_unavailable', 404);
        return this.window(id, origin);
    }
    async request(id, origin) {
        pairingId(id);
        const row = await this.q(`${REQUEST_SELECT} WHERE p.id=? AND w.origin=?`, id, origin).first();
        requireValue(row, 'pairing_unavailable', 404);
        return publicPairing(row, this.now());
    }
    async start(input, origin) {
        const body = pairingStart(input);
        await this.budget('start', 120);
        await this.windowBudget(body.windowId, origin, 'start', 10);
        const codes = newPairingCodes(); const id = crypto.randomUUID();
        const deviceHash = await pairingDeviceHash(origin, codes.deviceCode);
        const codeHash = await digest(pairingCode(codes.userCode));
        const fingerprint = pairingFingerprint(body.proofHash); const now = this.now();
        const result = await this.q(`INSERT INTO probe_pairings(id,window_id,name,version,platform,proof_hash,fingerprint,device_hash,user_code_hash,created_at,next_poll_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM probe_pairing_windows WHERE id=? AND origin=? AND cancelled_at IS NULL AND expires_at>?)
            AND (SELECT COUNT(*) FROM probe_pairings WHERE window_id=?)<3`,
            id, body.windowId, body.name, body.version, body.platform, body.proofHash, fingerprint, deviceHash, codeHash, now, now + 5000,
            body.windowId, origin, now, body.windowId).run();
        if (!result.meta.changes) throw pairingRateLimit(300);
        const window = await this.window(body.windowId, origin);
        return { id, windowId: body.windowId, origin, ...codes, fingerprint, expiresAt: window.expiresAt, intervalSeconds: 5 };
    }
    async resolve(windowId, userCode, origin) {
        pairingId(windowId); const code = pairingCode(userCode);
        await this.budget('resolve', 60);
        await this.windowBudget(windowId, origin, 'resolve', 10);
        const row = await this.q(`${REQUEST_SELECT} WHERE p.window_id=? AND w.origin=? AND p.user_code_hash=?`, windowId, origin, await digest(code)).first();
        requireValue(row, 'pairing_unavailable', 404);
        return publicPairing(row, this.now());
    }
    async approve(id, userCode, confirmed, origin) {
        pairingId(id); const code = pairingCode(userCode);
        requireValue(confirmed === true, 'pairing_confirmation_required');
        await this.budget('resolve', 60);
        const row = await this.q(`${REQUEST_SELECT} WHERE p.id=? AND w.origin=?`, id, origin).first();
        requireValue(row, 'pairing_unavailable', 404);
        await this.windowBudget(row.window_id, origin, 'resolve', 10);
        requireValue(samePairingHash(row.user_code_hash, await digest(code)), 'pairing_unavailable', 404);
        const now = this.now();
        requireValue(['pending', 'approved'].includes(requestStatus(row, now)), 'pairing_unavailable', 409);
        await this.q(`UPDATE probe_pairings SET state='approved',approved_at=? WHERE id=? AND state='pending'
            AND EXISTS(SELECT 1 FROM probe_pairing_windows WHERE id=window_id AND origin=? AND cancelled_at IS NULL AND expires_at>?)`, now, id, origin, now).run();
        const updated = await this.request(id, origin);
        requireValue(updated.status === 'approved', 'pairing_unavailable', 409);
        return updated;
    }
    async token(input, origin) {
        const body = pairingToken(input);
        await this.budget('token', 2400);
        await this.windowBudget(body.windowId, origin, 'token', 300, false);
        const row = await this.q(`${REQUEST_SELECT} WHERE p.id=? AND p.window_id=? AND w.origin=?`, body.id, body.windowId, origin).first();
        const deviceHash = await pairingDeviceHash(origin, body.deviceCode); const proofHash = await digest(body.proof);
        const deviceMatches = samePairingHash(row?.device_hash ?? '0'.repeat(64), deviceHash);
        const proofMatches = samePairingHash(row?.proof_hash ?? '0'.repeat(64), proofHash);
        requireValue(row && deviceMatches && proofMatches, 'pairing_unavailable', 404);
        let now = this.now(); const status = requestStatus(row, now);
        if (status === 'consumed') throw probeError('pairing_consumed', 409);
        if (status === 'cancelled' || status === 'expired') throw probeError(`pairing_${status}`, 410);
        const polled = await this.q(`UPDATE probe_pairings SET poll_count=poll_count+1,next_poll_at=?+interval_seconds*1000
            WHERE id=? AND next_poll_at<=? AND poll_count<100 RETURNING id`, now, row.id, now).first();
        if (!polled) {
            const current = await this.q('SELECT poll_count FROM probe_pairings WHERE id=?', row.id).first();
            if (!current || current.poll_count >= 100) throw pairingRateLimit((row.expires_at - now) / 1000);
            const slowed = await this.q(`UPDATE probe_pairings SET interval_seconds=MIN(interval_seconds+5,60),next_poll_at=?+MIN(interval_seconds+5,60)*1000
                WHERE id=? RETURNING interval_seconds`, now, row.id).first();
            throw pairingRateLimit(slowed.interval_seconds, 'pairing_slow_down');
        }
        if (status === 'pending') return { status: 'pending', expiresAt: row.expires_at, intervalSeconds: row.interval_seconds };
        const agentId = crypto.randomUUID(); const token = `mp1_${randomToken()}`;
        const tokenHash = await originTokenHash(token, origin); now = this.now();
        const result = await this.db.batch([
            this.q(`UPDATE probe_pairings SET state='consumed',agent_id=?,consumed_at=? WHERE id=? AND state='approved'
                AND EXISTS(SELECT 1 FROM probe_pairing_windows WHERE id=window_id AND origin=? AND cancelled_at IS NULL AND expires_at>?)
                AND (SELECT COUNT(*) FROM probe_agents WHERE revoked_at IS NULL)<32`, agentId, now, row.id, origin, now),
            this.q(`INSERT INTO probe_agents(id,name,token_hash,created_at,version,platform)
                SELECT ?,name,?,?,version,platform FROM probe_pairings WHERE id=? AND state='consumed' AND agent_id=?`, agentId, tokenHash, now, row.id, agentId)
        ]);
        if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1) {
            const current = await this.request(row.id, origin);
            if (current.status === 'consumed') throw probeError('pairing_consumed', 409);
            if (current.status === 'cancelled' || current.status === 'expired') throw probeError(`pairing_${current.status}`, 410);
            throw probeError('agent_limit', 409);
        }
        return { status: 'consumed', agent: { id: agentId, name: row.name, createdAt: now }, config: { version: 1, server: origin, token, pollSeconds: 60 } };
    }
}
