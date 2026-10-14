import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { database } from './sqlite-helper.mjs';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { LEASE_MS, normalizeOptions } from '../../functions/services/probe-contract.js';

const start = 1791800000000;
const declaration = { schemaVersion: 1, observationsVersion: 1 };
const claimInfo = {
    version: '0.2.0',
    platform: 'linux-amd64',
    observationsVersion: 1,
    capabilities: declaration,
};
const node = {
    id: 'fixture-node',
    name: 'Fixture',
    proxy: {
        type: 'trojan',
        server: 'example.invalid',
        port: 443,
        password: 'fixture-node-secret',
    },
    format: { status: 'passed', code: 'ok' },
};
const runtimeError = (error) => error?.code === 'probe_runtime_unavailable' && error.status === 503;
const modeError = (error) => error?.code === 'probe_runtime_mode_invalid' && error.status === 503;

async function preRuntimeStore() {
    const directory = new URL('../fixtures/probe-pre-runtime/', import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('fixture.json', directory), 'utf8'));
    assert.equal(manifest.commit, '553f190d10c8f6e990b622291c03b18d8f3b77f3');
    assert.equal(manifest.source.file, 'probe-store.js');
    assert.equal(manifest.source.path, 'functions/services/probe-store.js');
    assert.equal(
        manifest.source.sha256,
        '71db1e183e5ab7085ff034f29d3458794a9e7c05ef4c4a22a008b12954ed6d6f'
    );
    const source = readFileSync(new URL(manifest.source.file, directory));
    const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(source.length, manifest.source.bytes);
    assert.equal(sha256(source), manifest.source.sha256, 'Pre-runtime source bytes changed');
    const expectedDependencies = [
        'functions/services/probe-contract.js',
        'functions/services/probe-agent-management.js',
        'functions/services/probe-execution-metadata.js',
        'functions/services/probe-observations.js',
        'functions/services/probe-result-rules.js',
        'functions/services/diagnostics/contract.js',
    ];
    assert.deepEqual(
        manifest.dependencies.map((entry) => entry.path),
        expectedDependencies
    );
    for (const entry of manifest.dependencies) {
        const bytes = readFileSync(new URL(`../../${entry.path}`, import.meta.url));
        assert.equal(bytes.length, entry.bytes, `Pre-runtime dependency size drift: ${entry.path}`);
        assert.equal(
            sha256(bytes),
            entry.sha256,
            `Pre-runtime dependency byte drift: ${entry.path}`
        );
    }
    const imports = expectedDependencies
        .slice(0, 3)
        .map((path) => ({ specifier: `./${path.split('/').at(-1)}`, path }));
    assert.deepEqual(manifest.imports, imports);
    let rewritten = source.toString('utf8');
    for (const entry of imports) {
        const target = `from '${entry.specifier}'`;
        assert.equal(
            rewritten.split(target).length,
            2,
            `Expected one original import: ${entry.specifier}`
        );
        rewritten = rewritten.replace(
            target,
            `from '${new URL(`../../${entry.path}`, import.meta.url).href}'`
        );
    }
    assert.equal(/from\s+['"]\.\//.test(rewritten), false);
    const module = await import(
        `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`
    );
    return module.ProbeStore;
}

function instrument(raw) {
    const queries = [];
    const db = {
        queries,
        beforeBatch: null,
        prepare(sql) {
            queries.push(sql);
            const bind = (values = []) => ({
                ...raw.prepare(sql).bind(...values),
                bind: (...params) => bind(params),
                fixtureSql: sql,
            });
            return bind();
        },
        async batch(statements) {
            if (db.beforeBatch) await db.beforeBatch(statements);
            return raw.batch(statements);
        },
    };
    return db;
}

async function fixture({ mode = 'read', migrate = true } = {}) {
    let now = start,
        serial = 0;
    const raw = database(),
        db = instrument(raw);
    const store = await new ProbeStore(db, () => now, { runtimeMode: mode }).init();
    if (migrate) {
        const schema = readFileSync(
            new URL('../../migrations/probes/0001_agent_runtime.sql', import.meta.url),
            'utf8'
        );
        await db.batch(
            schema
                .split(';')
                .map((sql) => sql.trim())
                .filter(Boolean)
                .map((sql) => db.prepare(sql))
        );
    }
    const agent = await store.addAgent('Fixture detector');
    const job = (types = ['tcp']) =>
        store.createJob(
            { nodes: [node], agentIds: [agent.id], ...normalizeOptions({ types }, 1, 1) },
            `runtime-fixture-${++serial}`
        );
    const state = async () => ({
        agent: await raw.prepare('SELECT * FROM probe_agents WHERE id=?').bind(agent.id).first(),
        tasks: (await raw.prepare('SELECT * FROM probe_tasks ORDER BY id').all()).results,
    });
    const runtime = () =>
        raw.prepare('SELECT * FROM probe_agent_runtime_v1 WHERE agent_id=?').bind(agent.id).first();
    const overview = async () =>
        (await store.agentsOverview()).agents.find((a) => a.id === agent.id);
    db.queries.length = 0;
    return {
        raw,
        db,
        store,
        agent,
        job,
        state,
        runtime,
        overview,
        now: () => now,
        advance: (ms) => {
            now += ms;
        },
        setNow: (value) => {
            now = value;
        },
    };
}

test('SQLite batch returns actual RETURNING rows and preserves sequential changes() across statements', async () => {
    const db = database();
    await db.prepare('CREATE TABLE fixture(id INTEGER PRIMARY KEY, value INTEGER)').run();
    const results = await db.batch([
        db.prepare('INSERT INTO fixture VALUES(1,10) RETURNING id,value'),
        db.prepare('UPDATE fixture SET value=20 WHERE id=1 AND changes()=1 RETURNING id,value'),
        db.prepare('UPDATE fixture SET value=30 WHERE id=2 RETURNING id,value'),
        db.prepare('UPDATE fixture SET value=40 WHERE id=1 AND changes()=1 RETURNING id,value'),
    ]);
    assert.deepEqual(
        results.map((r) => r.results.map((row) => ({ ...row }))),
        [[{ id: 1, value: 10 }], [{ id: 1, value: 20 }], [], []]
    );
    assert.deepEqual(
        results.map((r) => r.meta.changes),
        [1, 1, 0, 0]
    );
    assert.equal((await db.prepare('SELECT value FROM fixture').first()).value, 20);
});

test('default and explicit off operate on the old schema without any runtime table access', async () => {
    for (const mode of [undefined, 'off']) {
        const f = await fixture({ mode: 'off', migrate: false });
        if (mode === undefined) f.store = new ProbeStore(f.db, f.now);
        await f.job();
        const task = await f.store.claim(f.agent, claimInfo);
        assert.ok(task);
        f.advance(1000);
        await f.store.heartbeat(f.agent, task.id, task.leaseToken);
        assert.equal((await f.store.agentsOverview()).agents[0].capabilities, null);
        assert.equal((await f.store.agentHistory(f.agent.id)).agent.lastHeartbeatAt, null);
        assert.equal(
            f.db.queries.some((sql) => sql.includes('probe_agent_runtime_v1')),
            false
        );
        assert.equal(
            await f.raw
                .prepare("SELECT name FROM sqlite_master WHERE name='probe_agent_runtime_v1'")
                .first(),
            null
        );
    }
});

test('record captures canonical claims but keeps management responses on the original contract', async () => {
    const f = await fixture({ mode: 'record' });
    assert.equal(await f.store.claim(f.agent, claimInfo), null);
    assert.deepEqual(
        { ...(await f.runtime()) },
        {
            agent_id: f.agent.id,
            claim_received_at: start,
            last_heartbeat_at: null,
            declaration_state: 'declared',
            observations_version: 1,
            capabilities_json: JSON.stringify(declaration),
        }
    );
    f.db.queries.length = 0;
    const overview = await f.overview(),
        history = await f.store.agentHistory(f.agent.id);
    assert.equal(overview.capabilities, null);
    assert.equal(overview.lastHeartbeatAt, null);
    assert.equal(history.agent.capabilities, null);
    assert.equal(
        f.db.queries.some((sql) => sql.includes('probe_agent_runtime_v1')),
        false
    );
});

test('read returns only this agent declaration and server receipt time', async () => {
    const f = await fixture();
    await f.store.claim(f.agent, {
        ...claimInfo,
        token: 'fixture-claim-secret',
        receivedAt: start + 999999,
        capabilities: { ...declaration, path: '/fixture/private' },
    });
    const current = await f.overview();
    assert.equal(current.capabilities.receivedAt, start);
    assert.equal(current.capabilities.source, 'agent_claim');
    assert.equal(current.lastHeartbeatAt, null);
    const text = JSON.stringify([current, await f.runtime()]);
    for (const secret of ['fixture-claim-secret', '/fixture/private'])
        assert.ok(!text.includes(secret));
    const other = await f.store.addAgent('Other detector');
    assert.equal((await f.store.agentHistory(other.id)).agent.capabilities, null);
});

test('legacy and missing claims fully replace a prior declaration without retaining its JSON', async () => {
    const f = await fixture();
    await f.store.claim(f.agent, claimInfo);
    f.advance(1000);
    await f.store.claim(f.agent, { observationsVersion: 1 });
    assert.equal((await f.runtime()).declaration_state, 'legacy');
    assert.equal((await f.runtime()).capabilities_json, null);
    assert.equal((await f.runtime()).observations_version, 1);
    f.advance(1000);
    await f.store.claim(f.agent, {});
    const row = await f.runtime();
    assert.equal(row.declaration_state, 'missing');
    assert.equal(row.claim_received_at, f.now());
    assert.equal(row.capabilities_json, null);
    assert.equal(row.observations_version, null);
});

test('live claim normalization alone selects observations and malformed declarations still admit ordinary work', async () => {
    for (const [info, expected] of [
        [{}, 'missing'],
        [
            { observationsVersion: 1, capabilities: { schemaVersion: 2, observationsVersion: 1 } },
            'unsupported_schema',
        ],
        [{ observationsVersion: 1, capabilities: null }, 'invalid_declaration'],
        [{ observationsVersion: 2, capabilities: declaration }, 'conflicting_versions'],
    ]) {
        const f = await fixture();
        await f.store.claim(f.agent, claimInfo);
        const observations = await f.job(['observations']);
        f.advance(1);
        const ordinary = await f.job();
        const task = await f.store.claim(f.agent, info);
        assert.equal(task.jobId, ordinary.id);
        assert.equal((await f.runtime()).declaration_state, expected);
        const queued = (await f.state()).tasks.find((row) => row.job_id === observations.id);
        assert.equal(queued.state, 'queued');
        assert.equal(queued.attempt, 0);
    }
});

test('legacy observations claims remain eligible and an old stored declaration cannot grant a missing claim', async () => {
    const f = await fixture();
    await f.store.claim(f.agent, claimInfo);
    const job = await f.job(['observations']);
    assert.equal(await f.store.claim(f.agent, {}), null);
    const task = await f.store.claim(f.agent, { observationsVersion: 1 });
    assert.equal(task.jobId, job.id);
    assert.equal((await f.runtime()).declaration_state, 'legacy');
});

test('read freshness expires by claim time and successful heartbeats do not refresh it', async () => {
    const f = await fixture();
    const job = await f.job();
    const task = await f.store.claim(f.agent, claimInfo);
    for (let i = 0; i < 4; i++) {
        f.advance(60000);
        await f.store.heartbeat(f.agent, task.id, task.leaseToken);
    }
    f.advance(59999);
    await f.store.heartbeat(f.agent, task.id, task.leaseToken);
    assert.equal((await f.overview()).capabilities.freshness, 'fresh');
    f.advance(1);
    await f.store.heartbeat(f.agent, task.id, task.leaseToken);
    const current = await f.overview();
    assert.equal(current.capabilities.freshness, 'stale');
    assert.equal(current.capabilities.receivedAt, start);
    assert.equal(current.lastHeartbeatAt, f.now());
    assert.equal((await f.runtime()).claim_received_at, start);
    assert.equal((await f.store.results(job.id)).nodes[0].state, 'running');
});

test('heartbeat-only rollout rows retain unknown claims and never manufacture capabilities', async () => {
    const f = await fixture({ mode: 'off' });
    await f.job();
    const task = await f.store.claim(f.agent, claimInfo);
    const enabled = new ProbeStore(f.db, f.now, { runtimeMode: 'read' });
    f.advance(1000);
    await enabled.heartbeat(f.agent, task.id, task.leaseToken);
    const row = await f.runtime();
    assert.equal(row.claim_received_at, null);
    assert.equal(row.last_heartbeat_at, f.now());
    assert.equal(row.capabilities_json, null);
    assert.equal((await enabled.agentsOverview()).agents[0].capabilities, null);
});

test('read suppresses future claim timestamps and revoked declarations while keeping valid heartbeat history', async () => {
    const f = await fixture();
    await f.job();
    const task = await f.store.claim(f.agent, claimInfo);
    f.advance(1000);
    await f.store.heartbeat(f.agent, task.id, task.leaseToken);
    await f.raw
        .prepare('UPDATE probe_agent_runtime_v1 SET claim_received_at=? WHERE agent_id=?')
        .bind(f.now() + 1, f.agent.id)
        .run();
    assert.equal((await f.overview()).capabilities, null);
    await f.raw
        .prepare('UPDATE probe_agent_runtime_v1 SET claim_received_at=? WHERE agent_id=?')
        .bind(start, f.agent.id)
        .run();
    await f.store.revokeAgent(f.agent.id);
    const current = await f.overview();
    assert.equal(current.capabilities, null);
    assert.equal(current.lastHeartbeatAt, start + 1000);
});

test('missing runtime schema fails closed before claim consumption and still permits revoke', async () => {
    for (const mode of ['record', 'read']) {
        const f = await fixture({ mode, migrate: false });
        await f.job();
        const before = await f.state();
        await assert.rejects(f.store.claim(f.agent, claimInfo), runtimeError);
        assert.deepEqual(await f.state(), before);
        if (mode === 'read') {
            await assert.rejects(f.store.agentsOverview(), runtimeError);
            await assert.rejects(f.store.agentHistory(f.agent.id), runtimeError);
        }
        assert.equal(await f.store.revokeAgent(f.agent.id), true);
        assert.ok((await f.state()).tasks.every((t) => t.state === 'cancelled'));
        assert.equal(
            await f.raw
                .prepare("SELECT name FROM sqlite_master WHERE name='probe_agent_runtime_v1'")
                .first(),
            null
        );
    }
});

test('runtime write failure rolls claim contact and lease changes back atomically', async () => {
    const f = await fixture();
    await f.job();
    await f.raw
        .prepare(
            "CREATE TRIGGER reject_runtime_claim BEFORE INSERT ON probe_agent_runtime_v1 BEGIN SELECT RAISE(ABORT,'fixture write failure'); END"
        )
        .run();
    const before = await f.state();
    await assert.rejects(f.store.claim(f.agent, claimInfo), runtimeError);
    assert.deepEqual(await f.state(), before);
    assert.equal(await f.runtime(), null);
});

test('missing schema and runtime update failure cannot partially renew a heartbeat', async () => {
    for (const failure of ['missing', 'update']) {
        const f = await fixture();
        await f.job();
        const task = await f.store.claim(f.agent, claimInfo);
        const before = await f.state();
        if (failure === 'missing') await f.raw.prepare('DROP TABLE probe_agent_runtime_v1').run();
        else
            await f.raw
                .prepare(
                    "CREATE TRIGGER reject_runtime_heartbeat BEFORE UPDATE ON probe_agent_runtime_v1 BEGIN SELECT RAISE(ABORT,'fixture write failure'); END"
                )
                .run();
        f.advance(1000);
        await assert.rejects(f.store.heartbeat(f.agent, task.id, task.leaseToken), runtimeError);
        assert.deepEqual(await f.state(), before);
        assert.equal(await f.store.revokeAgent(f.agent.id), true);
    }
});

test('rejected heartbeats do not change either contact timestamp or runtime row', async () => {
    for (const failure of ['wrong-token', 'wrong-agent', 'expired', 'cancelled', 'revoked']) {
        const f = await fixture();
        const job = await f.job();
        const task = await f.store.claim(f.agent, claimInfo);
        f.advance(1000);
        if (failure === 'expired') f.advance(LEASE_MS);
        if (failure === 'cancelled') await f.store.cancel(job.id);
        if (failure === 'revoked') await f.store.revokeAgent(f.agent.id);
        const before = await f.state(),
            runtime = await f.runtime();
        const agent = failure === 'wrong-agent' ? { id: 'other-agent' } : f.agent;
        const token = failure === 'wrong-token' ? 'f'.repeat(64) : task.leaseToken;
        await assert.rejects(
            f.store.heartbeat(agent, task.id, token),
            (error) => error.code === 'lease_lost' && error.status === 409
        );
        assert.deepEqual(await f.state(), before);
        assert.deepEqual(await f.runtime(), runtime);
    }
});

test('same-identity concurrent claims admit one lease with runtime committed atomically', async () => {
    const f = await fixture();
    await f.job();
    const claims = await Promise.all([
        f.store.claim(f.agent, claimInfo),
        f.store.claim(f.agent, claimInfo),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await f.state()).tasks[0].attempt, 1);
    assert.equal((await f.runtime()).claim_received_at, start);
});

test('revocation immediately before claim batch fences stale authenticated agents and runtime writes', async () => {
    const f = await fixture();
    await f.job();
    f.db.beforeBatch = async (statements) => {
        if (!statements.some((s) => s.fixtureSql.includes('probe_agent_runtime_v1'))) return;
        f.db.beforeBatch = null;
        await f.store.revokeAgent(f.agent.id);
    };
    assert.equal(await f.store.claim(f.agent, claimInfo), null);
    assert.equal(await f.runtime(), null);
    const state = await f.state();
    assert.equal(state.agent.last_seen, 0);
    assert.equal(state.tasks[0].state, 'cancelled');
    assert.equal(state.tasks[0].attempt, 0);
});

test('revocation immediately before heartbeat batch prevents renewal and all heartbeat bookkeeping', async () => {
    const f = await fixture();
    await f.job();
    const task = await f.store.claim(f.agent, claimInfo);
    f.advance(1000);
    const runtime = await f.runtime();
    f.db.beforeBatch = async (statements) => {
        if (!statements.some((s) => s.fixtureSql.includes('probe_agent_runtime_v1'))) return;
        f.db.beforeBatch = null;
        await f.store.revokeAgent(f.agent.id);
    };
    await assert.rejects(
        f.store.heartbeat(f.agent, task.id, task.leaseToken),
        (error) => error.code === 'lease_lost'
    );
    assert.deepEqual(await f.runtime(), runtime);
    assert.equal((await f.state()).agent.last_seen, start);
    assert.equal((await f.state()).tasks[0].state, 'cancelled');
});

test('invalid modes fail only runtime consumers and do not prevent initialization or revocation', async () => {
    for (const runtimeMode of ['', null, false, 'READ', 'unknown']) {
        const f = await fixture({ mode: runtimeMode, migrate: false });
        await f.job();
        await assert.rejects(f.store.claim(f.agent, claimInfo), modeError);
        await assert.rejects(f.store.heartbeat(f.agent, 'fixture-task', 'a'.repeat(64)), modeError);
        await assert.rejects(f.store.agentsOverview(), modeError);
        await assert.rejects(f.store.agentHistory(f.agent.id), modeError);
        assert.equal(await f.store.revokeAgent(f.agent.id), true);
    }
});

test('HTTP runtime failures use stable no-store 503 responses without SQL or fixture secrets', async () => {
    const f = await fixture({ migrate: false });
    const handle = createProbeHandler({
        authorizeAdmin: async () => true,
        prepareNodes: async () => [node],
        loadManualNodes: async () => [node],
        makeStore: () => f.store,
    });
    const response = await handle(
        new Request('https://fixture.invalid/api/probes/v1/agent/claim', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${f.agent.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(claimInfo),
        }),
        {}
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), {
        success: false,
        error: { code: 'probe_runtime_unavailable' },
    });
});

test('off rollback ignores previously recorded rows and record replaces them before read', async () => {
    const f = await fixture();
    await f.store.claim(f.agent, claimInfo);
    const before = await f.runtime();
    const off = new ProbeStore(f.db, f.now, { runtimeMode: 'off' });
    f.advance(1000);
    f.db.queries.length = 0;
    await off.claim(f.agent, {});
    assert.equal((await off.agentsOverview()).agents[0].capabilities, null);
    assert.equal(
        f.db.queries.some((sql) => sql.includes('probe_agent_runtime_v1')),
        false
    );
    assert.deepEqual(await f.runtime(), before);
    const record = new ProbeStore(f.db, f.now, { runtimeMode: 'record' });
    await record.claim(f.agent, {});
    assert.equal((await f.runtime()).declaration_state, 'missing');
    assert.equal((await f.runtime()).capabilities_json, null);
    f.advance(300001);
    assert.equal((await f.overview()).capabilities.freshness, 'stale');
});

test('pre-runtime fixture preserves exact baseline source and shared dependency bytes', async () => {
    const LegacyStore = await preRuntimeStore();
    assert.equal(typeof LegacyStore, 'function');
    assert.equal(LegacyStore.prototype.runtimeEnabled, undefined);
    assert.notEqual(LegacyStore, ProbeStore);
});

test('actual pre-runtime code accepts the expanded schema and preserves runtime rows across rollback and warmup', async () => {
    const LegacyStore = await preRuntimeStore();
    const f = await fixture();
    const quietAgent = await f.store.addAgent('Quiet detector');
    await f.store.claim(quietAgent, claimInfo);
    const completedJob = await f.job();
    const completedTask = await f.store.claim(f.agent, claimInfo);
    const checks = { tcp: { status: 'passed', code: 'ok', latencyMs: 7 } };
    const executionMetadata = {
        schemaVersion: 1,
        wrapperVersion: '0.2.0',
        wrapperRevision: 'source',
        platform: 'linux-amd64',
        ruleSetVersion: 1,
    };
    await f.store.finish(
        f.agent,
        completedTask.id,
        completedTask.leaseToken,
        checks,
        executionMetadata
    );
    const runtimeBefore = (
        await f.raw.prepare('SELECT * FROM probe_agent_runtime_v1 ORDER BY agent_id').all()
    ).results;
    const completedBefore = await f.store.results(completedJob.id);
    const observationsJob = await f.job(['observations']);
    const legacy = await new LegacyStore(f.db, f.now).init();
    const authenticated = await legacy.authenticate(f.agent.token);
    assert.equal(authenticated.id, f.agent.id);
    f.db.queries.length = 0;
    f.advance(1000);
    const task = await legacy.claim(authenticated, {
        version: '0.2.0-old',
        platform: 'linux-amd64',
        observationsVersion: 1,
    });
    assert.equal(
        task.jobId,
        observationsJob.id,
        'Old top-level declaration must still admit observations'
    );
    f.advance(1000);
    await legacy.heartbeat(authenticated, task.id, task.leaseToken);
    assert.equal(
        (await f.state()).tasks.find((row) => row.id === task.id).lease_until,
        f.now() + LEASE_MS
    );
    assert.equal(
        (await legacy.agentsOverview()).agents.find((row) => row.id === f.agent.id).capabilities,
        null
    );
    assert.equal((await legacy.agentHistory(f.agent.id)).agent.lastHeartbeatAt, null);
    assert.deepEqual(await legacy.results(completedJob.id), completedBefore);
    assert.equal((await legacy.results(observationsJob.id)).nodes[0].state, 'running');
    assert.equal(
        f.db.queries.some((sql) => sql.includes('probe_agent_runtime_v1')),
        false
    );
    assert.deepEqual(
        (await f.raw.prepare('SELECT * FROM probe_agent_runtime_v1 ORDER BY agent_id').all())
            .results,
        runtimeBefore
    );
    await legacy.cancel(observationsJob.id);

    const off = new ProbeStore(f.db, f.now, { runtimeMode: 'off' });
    assert.deepEqual(await off.agentsOverview(), await legacy.agentsOverview());
    assert.deepEqual(await off.agentHistory(f.agent.id), await legacy.agentHistory(f.agent.id));
    const offJob = await f.job();
    const offTask = await off.claim(authenticated, { observationsVersion: 1 });
    assert.equal(offTask.jobId, offJob.id);
    f.advance(1000);
    await off.heartbeat(authenticated, offTask.id, offTask.leaseToken);
    await off.finish(authenticated, offTask.id, offTask.leaseToken, checks);
    assert.deepEqual((await legacy.results(offJob.id)).nodes[0].checks, checks);
    assert.deepEqual(
        (await f.raw.prepare('SELECT * FROM probe_agent_runtime_v1 ORDER BY agent_id').all())
            .results,
        runtimeBefore
    );

    const record = new ProbeStore(f.db, f.now, { runtimeMode: 'record' });
    await record.claim(f.agent, {});
    assert.equal((await f.runtime()).declaration_state, 'missing');
    assert.equal((await f.runtime()).capabilities_json, null);
    assert.equal(
        (await record.agentsOverview()).agents.find((row) => row.id === f.agent.id).capabilities,
        null
    );
    f.advance(300000);
    const resumed = new ProbeStore(f.db, f.now, { runtimeMode: 'read' });
    const visible = (await resumed.agentsOverview()).agents;
    assert.equal(visible.find((row) => row.id === f.agent.id).capabilities.state, 'missing');
    assert.ok(visible.every((row) => row.capabilities.freshness === 'stale'));
    await resumed.claim(f.agent, claimInfo);
    assert.equal((await resumed.agentHistory(f.agent.id)).agent.capabilities.freshness, 'fresh');
    assert.equal((await resumed.agentHistory(quietAgent.id)).agent.capabilities.freshness, 'stale');
});
