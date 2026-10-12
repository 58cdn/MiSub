import { digest, originTokenHash, randomToken, probeError, requireValue, publicAgent, sanitizeResult, MAX_ATTEMPTS, LEASE_MS } from './probe-contract.js';

export const PROBE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS probe_agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, revoked_at INTEGER, version TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS probe_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, cancelled_at INTEGER, types_json TEXT NOT NULL, options_json TEXT NOT NULL, total INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS probe_tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES probe_jobs(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES probe_agents(id), node_id TEXT NOT NULL, node_name TEXT NOT NULL, node_payload TEXT, state TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, lease_hash TEXT, lease_until INTEGER NOT NULL DEFAULT 0, result_json TEXT, result_hash TEXT, completed_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS probe_tasks_agent_state ON probe_tasks(agent_id, state, lease_until)`,
    `CREATE INDEX IF NOT EXISTS probe_tasks_job ON probe_tasks(job_id)`
];
const initialized = new WeakMap();
export const PROBE_AGENT_ONLINE_WINDOW_MS = 120000;
export const PROBE_RETENTION_DAYS = 7;
export const PROBE_HISTORY_STATES = ['queued', 'running', 'done', 'cancelled', 'expired'];
const AGENT_PUBLIC_COLUMNS = 'id,name,created_at,last_seen,revoked_at,version,platform';
const AGENT_SUMMARY_COLUMNS = `a.id,a.name,a.created_at,a.last_seen,a.revoked_at,a.version,a.platform,
    MAX(j.created_at) AS last_task_at,
    MAX(CASE WHEN t.state='done' THEN t.completed_at END) AS last_result_at,
    SUM(CASE WHEN t.state='queued' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN t.state='running' THEN 1 ELSE 0 END) AS running,
    SUM(CASE WHEN t.state='done' THEN 1 ELSE 0 END) AS done,
    SUM(CASE WHEN t.state IN ('expired','cancelled') THEN 1 ELSE 0 END) AS stopped`;
function agentSummary(row, checkedAt) {
    const age = checkedAt - row.last_seen;
    const status = row.revoked_at !== null ? 'revoked'
        : !Number.isSafeInteger(row.last_seen) || row.last_seen <= 0 || age < 0 ? 'unknown'
        : age <= PROBE_AGENT_ONLINE_WINDOW_MS ? 'online' : 'offline';
    return {
        ...publicAgent(row), status, lastTaskAt: row.last_task_at, lastResultAt: row.last_result_at,
        taskCounts: { queued: row.queued, running: row.running, done: row.done, stopped: row.stopped }
    };
}
function validateManagementPage(offset, limit) {
    requireValue(Number.isSafeInteger(offset) && offset >= 0 && offset <= 100000, 'invalid_offset');
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'invalid_limit');
}
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
    async agentsOverview(offset = 0, limit = 20) {
        validateManagementPage(offset, limit);
        await this.sweep();
        const checkedAt = this.now();
        const total = (await this.q('SELECT COUNT(*) AS n FROM probe_agents').first()).n;
        const rows = await this.q(`WITH selected_agents AS (
            SELECT ${AGENT_PUBLIC_COLUMNS} FROM probe_agents
            ORDER BY (revoked_at IS NOT NULL),created_at DESC,id LIMIT ? OFFSET ?
        ) SELECT ${AGENT_SUMMARY_COLUMNS} FROM selected_agents a
            LEFT JOIN probe_tasks t ON t.agent_id=a.id LEFT JOIN probe_jobs j ON j.id=t.job_id
            GROUP BY a.id ORDER BY (a.revoked_at IS NOT NULL),a.created_at DESC,a.id`, limit, offset).all();
        return {
            agents: rows.results.map(row => agentSummary(row, checkedAt)), total,
            nextOffset: offset + rows.results.length < total ? offset + rows.results.length : null,
            checkedAt, onlineWindowMs: PROBE_AGENT_ONLINE_WINDOW_MS, retentionDays: PROBE_RETENTION_DAYS
        };
    }
    async agentHistory(id, offset = 0, limit = 20, state = null) {
        validateManagementPage(offset, limit);
        requireValue(state === null || PROBE_HISTORY_STATES.includes(state), 'invalid_state');
        await this.sweep();
        const checkedAt = this.now();
        const row = await this.q(`SELECT ${AGENT_SUMMARY_COLUMNS} FROM probe_agents a
            LEFT JOIN probe_tasks t ON t.agent_id=a.id LEFT JOIN probe_jobs j ON j.id=t.job_id
            WHERE a.id=? GROUP BY a.id`, id).first();
        requireValue(row, 'agent_not_found', 404);
        const total = (await this.q(`SELECT COUNT(*) AS n FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id
            WHERE t.agent_id=? AND (? IS NULL OR t.state=?)`, id, state, state).first()).n;
        const rows = await this.q(`SELECT t.id,t.job_id,t.node_id,t.node_name,t.state,t.attempt,j.created_at,t.completed_at,t.result_json
            FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.agent_id=? AND (? IS NULL OR t.state=?)
            ORDER BY j.created_at DESC,t.id LIMIT ? OFFSET ?`, id, state, state, limit, offset).all();
        const records = rows.results.map(task => ({
            id: task.id, jobId: task.job_id, nodeId: task.node_id, nodeName: task.node_name,
            state: task.state, attempt: task.attempt, createdAt: task.created_at, completedAt: task.completed_at,
            checks: task.result_json ? JSON.parse(task.result_json) : null
        }));
        return {
            agent: agentSummary(row, checkedAt), records, total,
            nextOffset: offset + records.length < total ? offset + records.length : null,
            checkedAt, retentionDays: PROBE_RETENTION_DAYS
        };
    }
    async addAgent(name) {
        requireValue(typeof name === 'string' && name.trim().length > 0 && name.length <= 60 && !/[\x00-\x1f\x7f]/.test(name), 'invalid_agent_name');
        const id = crypto.randomUUID();
        const token = `mp1_${randomToken()}`;
        const now = this.now();
        const result = await this.q(`INSERT INTO probe_agents (id,name,token_hash,created_at)
            SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM probe_agents WHERE revoked_at IS NULL)<32`, id, name.trim(), await digest(token), now).run();
        requireValue(result.meta.changes === 1, 'agent_limit', 409);
        return { id, name: name.trim(), token, createdAt: now };
    }
    async authenticate(token, origin = '') {
        if (!/^mp1_[0-9a-f]{64}$/.test(token || '')) throw probeError('unauthorized', 401);
        const a = await this.q('SELECT * FROM probe_agents WHERE token_hash IN (?,?) AND revoked_at IS NULL', await digest(token), await originTokenHash(token, origin)).first();
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
            this.q('DELETE FROM probe_jobs WHERE created_at<?', now - PROBE_RETENTION_DAYS * 86400000)
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
            AND (json_extract(j.options_json,'$.observationsVersion') IS NULL OR (json_extract(j.options_json,'$.observationsVersion')=1 AND ?=1))
            AND (t.state='queued' OR (t.state='running' AND t.lease_until<=?)) AND t.attempt<?
            AND NOT EXISTS(SELECT 1 FROM probe_tasks busy WHERE busy.agent_id=? AND busy.state='running' AND busy.lease_until>?)
            ORDER BY j.created_at,t.id LIMIT 1) RETURNING id,job_id,node_payload,attempt`,
            await digest(leaseToken), now + LEASE_MS, agent.id, now, info.observationsVersion === 1 ? 1 : 0, now, MAX_ATTEMPTS, agent.id, now).first();
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
        const row = await this.q('SELECT t.*,j.types_json,j.options_json,j.created_at AS job_created_at FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.id=? AND t.agent_id=?', id, agent.id).first();
        requireValue(row, 'task_not_found', 404);
        const options = JSON.parse(row.options_json);
        const now = this.now();
        // Preserve server validation timestamps for an identical replay after a
        // lost ACK, instead of changing the hash/freshness on every delivery.
        const result = sanitizeResult(input, JSON.parse(row.types_json), options.services, options, { taskId: id, startedAt: row.job_created_at, now: row.completed_at ?? now });
        if (result.speed?.bytes !== undefined) requireValue(result.speed.bytes <= options.downloadBytes, 'invalid_result_metric');
        const encoded = JSON.stringify(result);
        const resultHash = await digest(encoded);
        const leaseHash = await digest(leaseToken);
        if (row.state === 'done' && row.lease_hash === leaseHash && row.result_hash === resultHash) return { accepted: true, replay: true };
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
