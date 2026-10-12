import { digest, randomToken, probeError, requireValue, publicAgent, sanitizeResult, MAX_ATTEMPTS, LEASE_MS } from './probe-contract.js';

export const PROBE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS probe_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, version TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS probe_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cancelled_at INTEGER, types_json TEXT NOT NULL, options_json TEXT NOT NULL, total INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS probe_tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES probe_jobs(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES probe_agents(id), node_id TEXT NOT NULL, node_name TEXT NOT NULL, node_payload TEXT, state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, lease_hash TEXT, lease_until INTEGER NOT NULL DEFAULT 0, result_json TEXT, result_hash TEXT, completed_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS probe_tasks_agent_state ON probe_tasks(agent_id, state, lease_until)`,
    `CREATE INDEX IF NOT EXISTS probe_tasks_job ON probe_tasks(job_id)`
];
const initialized = new WeakMap();
export class ProbeStore {
    constructor(db, now = Date.now) { this.db = db; this.now = now; }
    async init() {
        requireValue(this.db, 'probe_storage_not_configured', 503);
        if (!initialized.has(this.db)) initialized.set(this.db, this.db.batch(PROBE_SCHEMA.map(s => this.db.prepare(s))).catch(e => { initialized.delete(this.db); throw e; }));
        await initialized.get(this.db);
        return this;
    }
    q(sql, ...params) { return this.db.prepare(sql).bind(...params); }
    async agents() {
        const rows = await this.q('SELECT * FROM probe_agents ORDER BY (revoked_at IS NOT NULL), created_at DESC LIMIT 64').all();
        return rows.results.map(publicAgent);
    }
    async addAgent(name) {
        requireValue(typeof name === 'string' && name.trim().length > 0 && name.length <= 60 && !/[\x00-\x1f\x7f]/.test(name), 'invalid_agent_name');
        const count = await this.q('SELECT COUNT(*) AS n FROM probe_agents WHERE revoked_at IS NULL').first();
        requireValue(count.n < 32, 'agent_limit', 409);
        const id = crypto.randomUUID();
        const token = `mp1_${randomToken()}`;
        const now = this.now();
        await this.q('INSERT INTO probe_agents (id,name,token_hash,created_at) VALUES (?,?,?,?)', id, name.trim(), await digest(token), now).run();
        return { id, name: name.trim(), token, createdAt: now };
    }
    async authenticate(token) {
        if (!/^mp1_[0-9a-f]{64}$/.test(token || '')) throw probeError('unauthorized', 401);
        const a = await this.q('SELECT * FROM probe_agents WHERE token_hash=? AND revoked_at IS NULL', await digest(token)).first();
        if (!a) throw probeError('unauthorized', 401);
        return a;
    }
    async revokeAgent(id) {
        const now = this.now();
        const result = await this.db.batch([
            this.q('UPDATE probe_agents SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, id),
            this.q("UPDATE probe_tasks SET state='cancelled', node_payload=NULL, completed_at=? WHERE agent_id=? AND state IN ('queued','running')", now, id)
        ]);
        return result[0].meta.changes > 0;
    }
    async sweep() {
        const now = this.now();
        await this.db.batch([
            this.q("UPDATE probe_tasks SET state='expired', node_payload=NULL, completed_at=? WHERE state IN ('queued','running') AND job_id IN (SELECT id FROM probe_jobs WHERE expires_at<=?)", now, now),
            this.q("UPDATE probe_tasks SET state='expired', node_payload=NULL, completed_at=? WHERE state='running' AND lease_until<=? AND attempt>=?", now, now, MAX_ATTEMPTS),
            this.q('DELETE FROM probe_jobs WHERE created_at<?', now - 7 * 86400000)
        ]);
    }
    async createJob({ nodes, agentIds, types, options }, key) {
        requireValue(typeof key === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(key), 'idempotency_key_required');
        const requestHash = await digest(JSON.stringify({ nodes, agentIds, types, options }));
        const existing = await this.q('SELECT id,request_hash FROM probe_jobs WHERE idempotency_key=?', key).first();
        if (existing) {
            requireValue(existing.request_hash === requestHash, 'idempotency_conflict', 409);
            return { id: existing.id, replay: true };
        }
        const active = await this.q('SELECT id FROM probe_agents WHERE revoked_at IS NULL AND id IN (SELECT value FROM json_each(?))', JSON.stringify(agentIds)).all();
        requireValue(active.results.length === agentIds.length, 'agent_unavailable', 409);
        const id = crypto.randomUUID();
        const now = this.now();
        // Both inserts are one transaction. A revoke racing enqueue cannot admit work for the revoked agent.
        try {
            await this.db.batch([
                this.q(`INSERT INTO probe_jobs (id,idempotency_key,request_hash,created_at,expires_at,types_json,options_json,total)
                    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM probe_agents WHERE revoked_at IS NULL AND id IN (SELECT value FROM json_each(?)))=?`,
                    id, key, requestHash, now, now + 86400000, JSON.stringify(types), JSON.stringify(options), nodes.length * agentIds.length, JSON.stringify(agentIds), agentIds.length),
                this.q(`INSERT INTO probe_tasks (id,job_id,agent_id,node_id,node_name,node_payload)
                    SELECT ? || '_' || a.value || '_' || n.key, ?, a.value, json_extract(n.value,'$.id'), json_extract(n.value,'$.name'), n.value
                    FROM json_each(?) n CROSS JOIN json_each(?) a WHERE EXISTS(SELECT 1 FROM probe_jobs WHERE id=?)`,
                    id, id, JSON.stringify(nodes), JSON.stringify(agentIds), id)
            ]);
        } catch (error) {
            const raced = await this.q('SELECT id,request_hash FROM probe_jobs WHERE idempotency_key=?', key).first();
            if (!raced) throw error;
            requireValue(raced.request_hash === requestHash, 'idempotency_conflict', 409);
            return { id: raced.id, replay: true };
        }
        requireValue(await this.q('SELECT id FROM probe_jobs WHERE id=?', id).first(), 'agent_unavailable', 409);
        return { id, replay: false };
    }
    async claim(agent, info = {}) {
        await this.sweep();
        const now = this.now();
        const version = typeof info.version === 'string' && /^[\w.+-]{1,50}$/.test(info.version) ? info.version : '';
        const platform = typeof info.platform === 'string' && /^[a-z0-9_-]{1,30}$/.test(info.platform) ? info.platform : '';
        await this.q('UPDATE probe_agents SET last_seen=?,version=?,platform=? WHERE id=? AND revoked_at IS NULL', now, version, platform, agent.id).run();
        const leaseToken = randomToken();
        // Single-statement compare-and-set. At most one live lease per detector identity.
        const row = await this.q(`UPDATE probe_tasks SET state='running',attempt=attempt+1,lease_hash=?,lease_until=? WHERE id=(
            SELECT t.id FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id JOIN probe_agents a ON a.id=t.agent_id
            WHERE t.agent_id=? AND a.revoked_at IS NULL AND j.cancelled_at IS NULL AND j.expires_at>?
            AND (t.state='queued' OR (t.state='running' AND t.lease_until<=?)) AND t.attempt<?
            AND NOT EXISTS(SELECT 1 FROM probe_tasks busy WHERE busy.agent_id=? AND busy.state='running' AND busy.lease_until>?)
            ORDER BY j.created_at,t.id LIMIT 1) RETURNING id,job_id,node_payload,attempt`,
            await digest(leaseToken), now + LEASE_MS, agent.id, now, now, MAX_ATTEMPTS, agent.id, now).first();
        if (!row) return null;
        const job = await this.q('SELECT types_json,options_json FROM probe_jobs WHERE id=?', row.job_id).first();
        return { id: row.id, jobId: row.job_id, node: JSON.parse(row.node_payload), types: JSON.parse(job.types_json), options: JSON.parse(job.options_json), attempt: row.attempt, leaseToken, leaseMs: LEASE_MS };
    }
    async heartbeat(agent, id, leaseToken) {
        requireValue(typeof leaseToken === 'string' && /^[0-9a-f]{64}$/.test(leaseToken), 'invalid_lease');
        const now = this.now();
        const row = await this.q(`UPDATE probe_tasks SET lease_until=? WHERE id=? AND agent_id=? AND state='running' AND lease_hash=? AND lease_until>?
            AND job_id IN (SELECT id FROM probe_jobs WHERE cancelled_at IS NULL AND expires_at>?)
            AND EXISTS(SELECT 1 FROM probe_agents WHERE id=? AND revoked_at IS NULL) RETURNING id`,
            now + LEASE_MS, id, agent.id, await digest(leaseToken), now, now, agent.id).first();
        requireValue(row, 'lease_lost', 409);
        await this.q('UPDATE probe_agents SET last_seen=? WHERE id=?', now, agent.id).run();
        return { leaseMs: LEASE_MS };
    }
    async finish(agent, id, leaseToken, input) {
        requireValue(typeof leaseToken === 'string' && /^[0-9a-f]{64}$/.test(leaseToken), 'invalid_lease');
        const row = await this.q('SELECT t.*,j.types_json,j.options_json FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.id=? AND t.agent_id=?', id, agent.id).first();
        requireValue(row, 'task_not_found', 404);
        const options = JSON.parse(row.options_json);
        const result = sanitizeResult(input, JSON.parse(row.types_json), options.services);
        if (result.speed?.bytes !== undefined) requireValue(result.speed.bytes <= options.downloadBytes, 'invalid_result_metric');
        const encoded = JSON.stringify(result);
        const resultHash = await digest(encoded);
        const leaseHash = await digest(leaseToken);
        if (row.state === 'done' && row.lease_hash === leaseHash && row.result_hash === resultHash) return { accepted: true, replay: true };
        const now = this.now();
        const updated = await this.q(`UPDATE probe_tasks SET state='done',node_payload=NULL,result_json=?,result_hash=?,completed_at=?
            WHERE id=? AND agent_id=? AND state='running' AND lease_hash=? AND lease_until>?
            AND job_id IN (SELECT id FROM probe_jobs WHERE cancelled_at IS NULL AND expires_at>?)
            AND EXISTS(SELECT 1 FROM probe_agents WHERE id=? AND revoked_at IS NULL) RETURNING id`,
            encoded, resultHash, now, id, agent.id, leaseHash, now, now, agent.id).first();
        requireValue(updated, 'lease_lost', 409);
        return { accepted: true, replay: false };
    }
    async cancel(id) {
        const now = this.now();
        await this.db.batch([
            this.q('UPDATE probe_jobs SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?', now, id),
            this.q("UPDATE probe_tasks SET state='cancelled',node_payload=NULL,completed_at=? WHERE job_id=? AND state IN ('queued','running')", now, id)
        ]);
    }
    async jobs() {
        await this.sweep();
        const rows = await this.q(`SELECT j.id,j.created_at,j.expires_at,j.cancelled_at,j.types_json,j.options_json,j.total,
            SUM(CASE WHEN t.state='queued' THEN 1 ELSE 0 END) queued, SUM(CASE WHEN t.state='running' THEN 1 ELSE 0 END) running,
            SUM(CASE WHEN t.state='done' THEN 1 ELSE 0 END) done, SUM(CASE WHEN t.state IN ('expired','cancelled') THEN 1 ELSE 0 END) stopped
            FROM probe_jobs j LEFT JOIN probe_tasks t ON t.job_id=j.id GROUP BY j.id ORDER BY j.created_at DESC LIMIT 50`).all();
        return rows.results.map(({ types_json, options_json, ...r }) => ({ ...r, types: JSON.parse(types_json), options: JSON.parse(options_json) }));
    }
    async results(id, offset = 0) {
        await this.sweep();
        const job = await this.q('SELECT id,total,created_at,expires_at,cancelled_at FROM probe_jobs WHERE id=?', id).first();
        requireValue(job, 'job_not_found', 404);
        const rows = await this.q(`SELECT t.id,t.node_id,t.node_name,t.agent_id,a.name AS agent_name,t.state,t.attempt,t.completed_at,t.result_json
            FROM probe_tasks t JOIN probe_agents a ON a.id=t.agent_id WHERE t.job_id=? ORDER BY t.id LIMIT 200 OFFSET ?`, id, offset).all();
        return { job, nodes: rows.results.map(({ result_json, ...r }) => ({ ...r, checks: result_json ? JSON.parse(result_json) : null })), nextOffset: offset + rows.results.length < job.total ? offset + rows.results.length : null };
    }
}
