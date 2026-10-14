// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { LEASE_MS, normalizeOptions } from '../../functions/services/probe-contract.js';

const fixtures = [];
const claimInfo = {
    version: '0.2.0',
    platform: 'linux-amd64',
    observationsVersion: 1,
    capabilities: { schemaVersion: 1, observationsVersion: 1 },
};
const node = {
    id: 'fixture-node',
    name: 'Local D1 fixture',
    proxy: { type: 'trojan', server: 'example.invalid', port: 443, password: 'fixture-private' },
    format: { status: 'passed', code: 'ok' },
};
const schema = readFileSync(
    new URL('../../migrations/probes/0001_agent_runtime.sql', import.meta.url),
    'utf8'
);

afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
        await fixture.runtime.dispose();
        expect(fixture.outbound).toEqual([]);
    }
});

async function fixture({ migrate = true, mode = 'read' } = {}) {
    let now = 1791800000000,
        serial = 0;
    const value = { outbound: [] };
    value.runtime = new Miniflare({
        modules: true,
        compatibilityDate: '2025-08-01',
        script: 'export default { fetch() { return new Response("synthetic fixture"); } };',
        d1Databases: { DB: 'probe-agent-runtime-fixture' },
        d1Persist: false,
        host: '127.0.0.1',
        port: 0,
        outboundService(request) {
            value.outbound.push(new URL(request.url).origin);
            return new Response('forbidden', { status: 403 });
        },
    });
    fixtures.push(value);
    const db = await value.runtime.getD1Database('DB');
    const store = await new ProbeStore(db, () => now, { runtimeMode: mode }).init();
    const applyMigration = () =>
        db.batch(
            schema
                .split(';')
                .map((sql) => sql.trim())
                .filter(Boolean)
                .map((sql) => db.prepare(sql))
        );
    if (migrate) await applyMigration();
    const agent = await store.addAgent('Fixture detector');
    const job = (agentId = agent.id) =>
        store.createJob(
            { nodes: [node], agentIds: [agentId], ...normalizeOptions({ types: ['tcp'] }, 1, 1) },
            `d1-runtime-fixture-${++serial}`
        );
    const state = async () => ({
        agent: await db.prepare('SELECT * FROM probe_agents WHERE id=?').bind(agent.id).first(),
        tasks: (await db.prepare('SELECT * FROM probe_tasks ORDER BY id').all()).results,
    });
    const runtimeRow = () =>
        db.prepare('SELECT * FROM probe_agent_runtime_v1 WHERE agent_id=?').bind(agent.id).first();
    return {
        db,
        store,
        agent,
        job,
        state,
        runtimeRow,
        applyMigration,
        now: () => now,
        advance: (ms) => {
            now += ms;
        },
    };
}

describe('agent runtime atomic writes on actual local D1', () => {
    it('returns claim rows from batch and couples same-millisecond heartbeat writes to successful renewal', async () => {
        const f = await fixture();
        await f.job();
        const claims = await Promise.all([
            f.store.claim(f.agent, claimInfo),
            f.store.claim(f.agent, claimInfo),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const task = claims.find(Boolean);
        expect(task).toMatchObject({ attempt: 1, leaseMs: LEASE_MS, node: { id: node.id } });
        expect((await f.runtimeRow()).declaration_state).toBe('declared');
        expect((await f.state()).tasks[0].attempt).toBe(1);
        await f.db
            .prepare(
                'CREATE TABLE fixture_runtime_audit (id INTEGER PRIMARY KEY, kind TEXT NOT NULL)'
            )
            .run();
        await f.db
            .prepare(
                "CREATE TRIGGER audit_runtime_updates AFTER UPDATE ON probe_agent_runtime_v1 BEGIN INSERT INTO fixture_runtime_audit(kind) VALUES('runtime_update'); END"
            )
            .run();
        f.advance(1000);
        await f.store.heartbeat(f.agent, task.id, task.leaseToken);
        await f.store.heartbeat(f.agent, task.id, task.leaseToken);
        expect(
            await f.db.prepare('SELECT count(*) AS n FROM fixture_runtime_audit').first('n')
        ).toBe(2);
        const before = await f.state(),
            row = await f.runtimeRow();
        expect(before.tasks[0].lease_until).toBe(f.now() + LEASE_MS);
        expect(before.agent.last_seen).toBe(f.now());
        expect(row.last_heartbeat_at).toBe(f.now());
        expect(row.claim_received_at).toBe(1791800000000);
        await expect(f.store.heartbeat(f.agent, task.id, 'f'.repeat(64))).rejects.toMatchObject({
            code: 'lease_lost',
            status: 409,
        });
        expect(await f.state()).toEqual(before);
        expect(await f.runtimeRow()).toEqual(row);
        expect(
            await f.db.prepare('SELECT count(*) AS n FROM fixture_runtime_audit').first('n')
        ).toBe(2);
        await f.store.revokeAgent(f.agent.id);
        const revoked = await f.state();
        f.advance(1000);
        await expect(f.store.heartbeat(f.agent, task.id, task.leaseToken)).rejects.toMatchObject({
            code: 'lease_lost',
            status: 409,
        });
        expect(await f.state()).toEqual(revoked);
        expect(await f.runtimeRow()).toEqual(row);
        expect((await f.store.agentsOverview()).agents[0]).toMatchObject({
            capabilities: null,
            lastHeartbeatAt: row.last_heartbeat_at,
        });
    }, 30000);

    it('keeps the old schema usable in off mode and fails closed without consuming or renewing leases', async () => {
        const f = await fixture({ migrate: false, mode: 'off' });
        await f.job();
        const enabled = new ProbeStore(f.db, f.now, { runtimeMode: 'read' });
        const initial = await f.state();
        await expect(enabled.claim(f.agent, claimInfo)).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        expect(await f.state()).toEqual(initial);
        const task = await f.store.claim(f.agent, claimInfo);
        expect(task).not.toBeNull();
        f.advance(1000);
        await f.store.heartbeat(f.agent, task.id, task.leaseToken);
        expect((await f.store.agentsOverview()).agents[0].capabilities).toBeNull();
        const leased = await f.state();
        f.advance(1000);
        await expect(enabled.heartbeat(f.agent, task.id, task.leaseToken)).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        expect(await f.state()).toEqual(leased);
        await expect(enabled.agentsOverview()).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        await expect(enabled.agentHistory(f.agent.id)).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        expect(await enabled.revokeAgent(f.agent.id)).toBe(true);
        expect((await f.state()).tasks[0].state).toBe('cancelled');
        expect(
            await f.db
                .prepare("SELECT name FROM sqlite_master WHERE name='probe_agent_runtime_v1'")
                .first()
        ).toBeNull();
    }, 30000);

    it('rolls back agent and runtime writes when the lease CAS fails and rolls back renewal when bookkeeping fails', async () => {
        const f = await fixture();
        await f.job();
        await f.db
            .prepare(
                "CREATE TRIGGER reject_fixture_lease BEFORE UPDATE ON probe_tasks WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'fixture lease write failed'); END"
            )
            .run();
        const initial = await f.state();
        await expect(f.store.claim(f.agent, claimInfo)).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        expect(await f.state()).toEqual(initial);
        expect(await f.runtimeRow()).toBeNull();
        await f.db.prepare('DROP TRIGGER reject_fixture_lease').run();
        const task = await f.store.claim(f.agent, claimInfo);
        const before = await f.state(),
            row = await f.runtimeRow();
        await f.db
            .prepare(
                "CREATE TRIGGER reject_fixture_runtime BEFORE UPDATE ON probe_agent_runtime_v1 BEGIN SELECT RAISE(ABORT,'fixture runtime write failed'); END"
            )
            .run();
        f.advance(1000);
        await expect(f.store.heartbeat(f.agent, task.id, task.leaseToken)).rejects.toMatchObject({
            code: 'probe_runtime_unavailable',
            status: 503,
        });
        expect(await f.state()).toEqual(before);
        expect(await f.runtimeRow()).toEqual(row);
        expect(await f.store.revokeAgent(f.agent.id)).toBe(true);
    }, 30000);

    it('records heartbeat-only rollout without claiming a declaration and clears prior metadata for old clients', async () => {
        const f = await fixture({ mode: 'off' });
        await f.job();
        const task = await f.store.claim(f.agent, claimInfo);
        const read = new ProbeStore(f.db, f.now, { runtimeMode: 'read' });
        f.advance(1000);
        await read.heartbeat(f.agent, task.id, task.leaseToken);
        expect(await f.runtimeRow()).toMatchObject({
            claim_received_at: null,
            last_heartbeat_at: f.now(),
            declaration_state: 'missing',
            observations_version: null,
            capabilities_json: null,
        });
        expect((await read.agentsOverview()).agents[0].capabilities).toBeNull();
        await read.claim(f.agent, claimInfo);
        const recordedAt = f.now();
        expect((await f.runtimeRow()).capabilities_json).toBe(
            JSON.stringify(claimInfo.capabilities)
        );
        f.advance(1000);
        const record = new ProbeStore(f.db, f.now, { runtimeMode: 'record' });
        await record.claim(f.agent, {});
        expect((await record.agentsOverview()).agents[0]).toMatchObject({
            lastHeartbeatAt: null,
            capabilities: null,
        });
        const row = await f.runtimeRow();
        expect(row).toMatchObject({
            claim_received_at: f.now(),
            declaration_state: 'missing',
            observations_version: null,
            capabilities_json: null,
        });
        expect(row.claim_received_at).toBeGreaterThan(recordedAt);
        f.advance(300000);
        expect((await read.agentsOverview()).agents[0].capabilities).toMatchObject({
            state: 'missing',
            receivedAt: row.claim_received_at,
            freshness: 'stale',
        });
    }, 30000);
});
