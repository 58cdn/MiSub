import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProbeStore, PROBE_SCHEMA, PROBE_RETENTION_DAYS } from '../../functions/services/probe-store.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { digest, LEASE_MS, normalizeOptions, PROBE_TYPES, sanitizeResult } from '../../functions/services/probe-contract.js';
import { SOURCES, emptyResult } from '../../functions/services/diagnostics/contract.js';
import { sanitizeExecutionMetadata } from '../../functions/services/probe-execution-metadata.js';
import { ProbeStore as LegacyStore, PROBE_SCHEMA as LEGACY_SCHEMA } from '../fixtures/probe-legacy-7f/probe-store.js';
import { createProbeHandler as createLegacyHandler } from '../fixtures/probe-legacy-7f/probe-http.js';
import { database } from './sqlite-helper.mjs';

const ORIGIN = 'https://misub.example';
const BASE = `${ORIGIN}/api/probes/v1/`;
const START = Date.parse('2026-10-14T00:00:00Z');
const ADMIN = { 'x-test-admin': 'yes', Origin: ORIGIN };
const NODE = { id: 'fixture-node', name: 'Synthetic node', proxy: { password: 'PRIVATE_NODE_FIXTURE' }, format: { status: 'passed', code: 'ok' } };
const DECLARATION = Object.freeze({
    schemaVersion: 1,
    wrapperVersion: '0.3.0-fixture',
    wrapperRevision: 'b'.repeat(40),
    platform: 'linux-amd64',
    kernelLockVersion: 'v1.19.32',
    ruleSetVersion: 1,
});
const SNAPSHOT = Object.freeze({
    schemaVersion: 1,
    source: 'detector_reported',
    wrapperVersion: DECLARATION.wrapperVersion,
    wrapperRevision: DECLARATION.wrapperRevision,
    platform: DECLARATION.platform,
    kernelLockVersion: DECLARATION.kernelLockVersion,
    ruleSetVersion: 1,
});

function goodChecks(task, now) {
    const checks = {
        format: { status: 'passed', code: 'ok' },
        tcp: { status: 'passed', code: 'ok', latencyMs: 3 },
        proxy: { status: 'passed', code: 'ok', latencyMs: 8, httpStatus: 204 },
        speed: { status: 'unknown', code: 'probe_inconclusive', bytes: 1024, bytesPerSecond: 512, latencyMs: 2000, httpStatus: 200 },
        unlock: { status: 'unknown', code: 'probe_inconclusive', services: [{ service: 'netflix', status: 'unknown', code: 'service_reachable', httpStatus: 200, checkedAt: new Date(now).toISOString() }] },
        observations: {
            status: 'unknown', code: 'probe_inconclusive',
            report: {
                version: 1, requestId: task.id, scope: 'node',
                results: [{ ...emptyResult(SOURCES.find(source => source.id === 'ipify'), 'ok', null), checkedAt: new Date(now).toISOString(), httpStatus: 200, ip: '198.51.100.22', family: 4 }],
            },
        },
    };
    return Object.fromEntries(task.types.map(type => [type, checks[type]]));
}

async function fixture(types = ['tcp'], { claim = true } = {}) {
    let now = START;
    const db = database();
    const store = await new ProbeStore(db, () => now).init();
    const legacyStore = new LegacyStore(db, () => now);
    const agent = await store.addAgent('Synthetic detector');
    const options = normalizeOptions({ types, options: { services: ['netflix'], sources: ['ipify'], allowMetered: true } }, 1, 1);
    const job = await store.createJob({ nodes: [NODE], agentIds: [agent.id], ...options }, 'execution-fixture-key');
    const handlerOptions = current => ({
        authorizeAdmin: async request => request.headers.get('x-test-admin') === 'yes',
        makeStore: () => current,
        prepareNodes: async () => [NODE],
        loadManualNodes: async () => [NODE],
    });
    const handler = createProbeHandler(handlerOptions(store));
    const legacyHandler = createLegacyHandler(handlerOptions(legacyStore));
    const task = claim ? await store.claim(agent, { version: '0.2.0', platform: 'linux-amd64', observationsVersion: 1 }) : null;
    const checks = task ? goodChecks(task, now) : null;
    const expected = task ? sanitizeResult(checks, task.types, task.options.services, task.options, { taskId: task.id, startedAt: START, now }) : null;
    const call = async (route, body, { legacy = false, admin = false } = {}) => {
        const response = await (legacy ? legacyHandler : handler)(new Request(BASE + route, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...(admin ? ADMIN : { Authorization: `Bearer ${agent.token}` }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), { MISUB_PROBE_DB: db });
        return { status: response.status, body: await response.json() };
    };
    const submit = ({ metadata, value = checks, leaseToken = task?.leaseToken, legacy = false, id = task?.id } = {}) =>
        call(`agent/tasks/${id}/result`, { leaseToken, checks: value, ...(metadata === undefined ? {} : { executionMetadata: metadata }) }, { legacy });
    const row = () => store.q('SELECT * FROM probe_tasks WHERE job_id=?', job.id).first();
    const reads = async (legacy = false) => {
        const results = await call(`jobs/${job.id}`, undefined, { admin: true, legacy });
        const history = await call(`agents/${agent.id}/history`, undefined, { admin: true, legacy });
        assert.equal(results.status, 200);
        assert.equal(history.status, 200);
        return [results.body.data.nodes[0], history.body.data.records[0]];
    };
    return { db, store, legacyStore, agent, job, task, checks, expected, call, submit, row, reads, now: () => now, advance: milliseconds => { now += milliseconds; } };
}

function assertPublicRecord(record, checks, metadata) {
    assert.deepEqual(record.checks, checks);
    assert.deepEqual(record.executionMetadata, metadata);
    assert.equal(Object.hasOwn(record, 'metadataState'), false);
    for (const check of Object.values(record.checks ?? {})) assert.equal(Object.hasOwn(check, 'executionMetadata'), false);
    assert.ok(!JSON.stringify(record).includes('PRIVATE_NODE_FIXTURE'));
}

function assertError(response, status, code) {
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { success: false, error: { code } });
}

test('legacy compatibility fixture pins original routing, storage and shared result dependencies', async () => {
    const directory = new URL('../fixtures/probe-legacy-7f/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('fixture.json', directory), 'utf8'));
    assert.equal(manifest.commit, '7f794ec5fb6ab0b5cc51e75f1f24334035355bbc');
    const hash = content => createHash('sha256').update(content).digest('hex');
    for (const file of manifest.files) {
        const source = await readFile(new URL(file.path, directory), 'utf8');
        assert.equal(hash(source.replace(/\r\n/g, '\n')), file.fixtureSha256, file.path);
    }
    for (const dependency of manifest.dependencies) {
        // Deliberate dependency changes require a new, reviewed compatibility baseline.
        const source = await readFile(new URL(`../../${dependency.path}`, import.meta.url), 'utf8');
        assert.equal(hash(source.replace(/\r\n/g, '\n')), dependency.sha256, dependency.path);
    }
    assert.deepEqual(PROBE_SCHEMA, LEGACY_SCHEMA, 'execution snapshots do not change the database schema');
});

test('metadata canonicalization keeps only public fields and sets its own declaration source', () => {
    const dirty = { ...DECLARATION, source: 'server_verified', token: 'PRIVATE_METADATA_FIXTURE', path: 'PRIVATE_METADATA_FIXTURE', nested: { password: 'PRIVATE_METADATA_FIXTURE' } };
    assert.deepEqual(sanitizeExecutionMetadata(dirty), SNAPSHOT);
    assert.equal(dirty.source, 'server_verified');
    assert.equal(sanitizeExecutionMetadata(undefined), null);
    assert.equal(sanitizeExecutionMetadata(null), null);
    const sourceBuild = { ...DECLARATION, wrapperRevision: 'source' };
    delete sourceBuild.kernelLockVersion;
    const clean = sanitizeExecutionMetadata(sourceBuild);
    assert.equal(clean.wrapperRevision, 'source');
    assert.equal(Object.hasOwn(clean, 'kernelLockVersion'), false);
});

test('invalid metadata returns a fixed HTTP 400 without consuming the valid lease', async t => {
    const f = await fixture();
    const before = await f.row();
    const invalid = [
        ['array', []], ['string', 'PRIVATE_METADATA_FIXTURE'], ['boolean', false],
        ['schema version', { ...DECLARATION, schemaVersion: 2 }],
        ['schema type', { ...DECLARATION, schemaVersion: '1' }],
        ['missing wrapper', { ...DECLARATION, wrapperVersion: undefined }],
        ['wrapper path', { ...DECLARATION, wrapperVersion: 'PRIVATE_METADATA_FIXTURE/path' }],
        ['wrapper length', { ...DECLARATION, wrapperVersion: `1.2.3-${'a'.repeat(64)}` }],
        ['revision syntax', { ...DECLARATION, wrapperRevision: '../PRIVATE_METADATA_FIXTURE' }],
        ['revision case', { ...DECLARATION, wrapperRevision: 'A'.repeat(40) }],
        ['revision type', { ...DECLARATION, wrapperRevision: null }],
        ['platform', { ...DECLARATION, platform: 'unknown-platform' }],
        ['kernel type', { ...DECLARATION, kernelLockVersion: null }],
        ['kernel path', { ...DECLARATION, kernelLockVersion: 'PRIVATE_METADATA_FIXTURE/path' }],
        ['rule zero', { ...DECLARATION, ruleSetVersion: 0 }],
        ['rule upper bound', { ...DECLARATION, ruleSetVersion: 65536 }],
        ['rule fraction', { ...DECLARATION, ruleSetVersion: 1.5 }],
        ['rule boolean', { ...DECLARATION, ruleSetVersion: true }],
    ];
    for (const field of ['wrapperVersion', 'wrapperRevision', 'kernelLockVersion']) {
        for (const ending of ['\n', '\r\n']) {
            invalid.push([`${field} trailing ${JSON.stringify(ending)}`, { ...DECLARATION, [field]: DECLARATION[field] + ending }]);
        }
    }
    for (const [name, metadata] of invalid) await t.test(name, async () => {
        assertError(await f.submit({ metadata }), 400, 'invalid_execution_metadata');
        assert.deepEqual(await f.row(), before);
    });
    assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
});

for (const types of [['observations'], PROBE_TYPES]) {
    test(`${types.length === 1 ? 'observations-only' : 'all six checks'} snapshot survives old backend reads and ACK replay`, async () => {
        const f = await fixture(types);
        const response = await f.submit({ metadata: { ...DECLARATION, source: 'server_verified', token: 'PRIVATE_METADATA_FIXTURE' } });
        assert.deepEqual(response, { status: 200, body: { success: true, data: { accepted: true, replay: false } } });
        const accepted = await f.row();
        assert.equal(accepted.node_payload, null);
        assert.equal(accepted.result_hash, await digest(JSON.stringify(f.expected)));
        assert.notEqual(accepted.result_hash, await digest(accepted.result_json));
        const stored = JSON.parse(accepted.result_json);
        assert.deepEqual(Object.keys(stored), types);
        for (const type of types) assert.deepEqual(stored[type], { ...f.expected[type], executionMetadata: SNAPSHOT });
        assert.ok(!accepted.result_json.includes('PRIVATE_METADATA_FIXTURE'));
        for (const record of await f.reads()) assertPublicRecord(record, f.expected, SNAPSHOT);
        for (const record of await f.reads(true)) {
            assert.deepEqual(record.checks, stored);
            assert.equal(Object.hasOwn(record, 'executionMetadata'), false);
        }
        f.advance(2 * 86400000);
        const replay = await f.submit({ metadata: DECLARATION, legacy: true });
        assert.equal(replay.status, 200);
        assert.equal(replay.body.data.replay, true);
        assert.deepEqual(await f.row(), accepted);
        const wrongInput = structuredClone(f.checks);
        wrongInput.observations.executionMetadata = SNAPSHOT;
        assertError(await f.submit({ metadata: DECLARATION, value: wrongInput, legacy: true }), 400, 'invalid_observations_status');
        assertError(await f.submit({ metadata: DECLARATION, value: wrongInput }), 400, 'invalid_observations_status');
        assert.deepEqual(await f.row(), accepted);
    });
}

test('new client optional metadata is ignored by the pinned old HTTP backend and never backfilled', async () => {
    const f = await fixture(PROBE_TYPES);
    const first = await f.submit({ metadata: DECLARATION, legacy: true });
    assert.equal(first.status, 200);
    const accepted = await f.row();
    assert.equal(accepted.result_json, JSON.stringify(f.expected));
    assert.equal(accepted.result_hash, await digest(accepted.result_json));
    for (const record of await f.reads()) assertPublicRecord(record, f.expected, null);
    const replay = await f.submit({ metadata: { ...DECLARATION, wrapperVersion: '0.4.0' } });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replay, true);
    assert.deepEqual(await f.row(), accepted);
});

test('completed legacy results reject invalid declarations before replay without changing the row', async () => {
    const f = await fixture(PROBE_TYPES);
    assert.equal((await f.submit({ legacy: true })).status, 200);
    const accepted = await f.row();
    assertError(await f.submit({ metadata: { ...DECLARATION, wrapperVersion: 'PRIVATE_METADATA_FIXTURE/path' } }), 400, 'invalid_execution_metadata');
    assert.deepEqual(await f.row(), accepted);
    for (const record of await f.reads()) assertPublicRecord(record, f.expected, null);
});

test('old clients retain bare checks on a new backend with absent or null declarations', async t => {
    for (const metadata of [undefined, null]) await t.test(String(metadata), async () => {
        const f = await fixture(PROBE_TYPES);
        assert.equal((await f.submit({ metadata })).status, 200);
        const accepted = await f.row();
        assert.equal(accepted.result_json, JSON.stringify(f.expected));
        for (const record of await f.reads()) assertPublicRecord(record, f.expected, null);
        assert.equal((await f.submit({ legacy: true })).body.data.replay, true);
        assert.equal((await f.submit({ metadata: DECLARATION })).body.data.replay, true);
        assert.deepEqual(await f.row(), accepted);
    });
});

test('canonical replay preserves snapshot and completion time after upgrade and a later day', async () => {
    const f = await fixture(PROBE_TYPES);
    assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
    const accepted = await f.row();
    f.advance(2 * 86400000);
    await f.store.claim(f.agent, { version: '9.9.9', platform: 'windows-amd64', observationsVersion: 1 });
    const reordered = Object.fromEntries(Object.entries(DECLARATION).reverse());
    reordered.source = 'server_verified';
    reordered.rawResponse = 'PRIVATE_METADATA_FIXTURE';
    const replay = await f.submit({ metadata: reordered });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.replay, true);
    assert.deepEqual(await f.row(), accepted);
    for (const record of await f.reads()) assertPublicRecord(record, f.expected, SNAPSHOT);
});

test('missing or changed canonical declarations cannot replay a snapshotted result', async t => {
    const f = await fixture();
    assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
    const accepted = await f.row();
    const changes = [
        ['missing', undefined], ['null', null],
        ['wrapper', { ...DECLARATION, wrapperVersion: '0.4.0' }],
        ['revision', { ...DECLARATION, wrapperRevision: 'c'.repeat(40) }],
        ['platform', { ...DECLARATION, platform: 'windows-amd64' }],
        ['kernel', { ...DECLARATION, kernelLockVersion: 'v1.19.33' }],
        ['kernel omitted', { ...DECLARATION, kernelLockVersion: undefined }],
        ['rules', { ...DECLARATION, ruleSetVersion: 2 }],
    ];
    for (const [name, metadata] of changes) await t.test(name, async () => {
        assertError(await f.submit({ metadata }), 409, 'execution_metadata_conflict');
        assert.deepEqual(await f.row(), accepted);
    });
});

test('partial, null, wrongly sourced and inconsistent stored replicas stay unknown and reject replay', async t => {
    const mutations = [
        ['partial', stored => { delete stored.proxy.executionMetadata; }],
        ['null', stored => { stored.proxy.executionMetadata = null; }],
        ['all null', stored => { for (const check of Object.values(stored)) check.executionMetadata = null; }],
        ['wrong source', stored => { stored.proxy.executionMetadata.source = 'PRIVATE_METADATA_FIXTURE'; }],
        ['invalid field', stored => { stored.proxy.executionMetadata.wrapperVersion = ['PRIVATE_METADATA_FIXTURE']; }],
        ['inconsistent', stored => { stored.proxy.executionMetadata.wrapperRevision = 'c'.repeat(40); }],
    ];
    for (const [name, mutate] of mutations) await t.test(name, async () => {
        const f = await fixture(['tcp', 'proxy']);
        assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
        const stored = JSON.parse((await f.row()).result_json);
        mutate(stored);
        await f.store.q('UPDATE probe_tasks SET result_json=? WHERE id=?', JSON.stringify(stored), f.task.id).run();
        const corrupted = await f.row();
        for (const record of await f.reads()) {
            assertPublicRecord(record, f.expected, null);
            assert.ok(!JSON.stringify(record).includes('PRIVATE_METADATA_FIXTURE'));
        }
        assertError(await f.submit({ metadata: DECLARATION }), 409, 'execution_metadata_conflict');
        assert.deepEqual(await f.row(), corrupted);
    });
});

test('concurrent different declarations commit one complete snapshot without mixing replicas', { timeout: 5000 }, async () => {
    const f = await fixture(PROBE_TYPES);
    const original = f.store.q.bind(f.store);
    let reads = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    f.store.q = (sql, ...parameters) => {
        const query = original(sql, ...parameters);
        if (!sql.startsWith('SELECT t.*,j.types_json')) return query;
        return { ...query, first: async () => {
            const row = await query.first();
            if (++reads <= 2) { if (reads === 2) release(); await barrier; }
            return row;
        } };
    };
    const declarations = [DECLARATION, { ...DECLARATION, wrapperRevision: 'c'.repeat(40) }];
    const responses = await Promise.all(declarations.map(metadata => f.submit({ metadata })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = responses.findIndex(response => response.status === 200);
    const accepted = await f.row();
    for (const check of Object.values(JSON.parse(accepted.result_json))) assert.equal(check.executionMetadata.wrapperRevision, declarations[winner].wrapperRevision);
    assert.equal((await f.submit({ metadata: declarations[winner] })).body.data.replay, true);
    assertError(await f.submit({ metadata: declarations[1 - winner] }), 409, 'execution_metadata_conflict');
    assert.deepEqual(await f.row(), accepted);
});

test('final compare-and-set rejects expiry, cancellation, revocation and lease replacement without result residue', async t => {
    const boundaries = [
        ['lease expired', async (f, q) => q('UPDATE probe_tasks SET lease_until=? WHERE id=?', f.now(), f.task.id).run()],
        ['job expired', async (f, q) => q('UPDATE probe_jobs SET expires_at=? WHERE id=?', f.now(), f.job.id).run()],
        ['job cancelled', async (f, q) => q('UPDATE probe_jobs SET cancelled_at=? WHERE id=?', f.now(), f.job.id).run()],
        ['task cancelled', async (f, q) => q("UPDATE probe_tasks SET state='cancelled' WHERE id=?", f.task.id).run()],
        ['agent revoked', async (f, q) => q('UPDATE probe_agents SET revoked_at=? WHERE id=?', f.now(), f.agent.id).run()],
        ['lease replaced', async (f, q) => q('UPDATE probe_tasks SET lease_hash=? WHERE id=?', await digest('f'.repeat(64)), f.task.id).run()],
    ];
    for (const [name, change] of boundaries) await t.test(name, async () => {
        const f = await fixture();
        const original = f.store.q.bind(f.store);
        let reached = false, boundaryRow;
        f.store.q = (sql, ...parameters) => {
            const query = original(sql, ...parameters);
            if (!sql.startsWith("UPDATE probe_tasks SET state='done'")) return query;
            return { ...query, first: async () => {
                reached = true;
                await change(f, original);
                boundaryRow = await f.row();
                return query.first();
            } };
        };
        assertError(await f.submit({ metadata: DECLARATION }), 409, 'lease_lost');
        assert.equal(reached, true);
        assert.deepEqual(await f.row(), boundaryRow);
        assert.equal(boundaryRow.result_json, null);
        assert.equal(boundaryRow.result_hash, null);
        assert.equal(boundaryRow.completed_at, null);
    });
});

test('reclaim snapshots only the winning attempt and rejects the previous lease', async () => {
    const f = await fixture();
    f.advance(LEASE_MS + 1);
    const retry = await f.store.claim(f.agent, { version: '0.4.0', platform: 'linux-amd64' });
    assert.equal(retry.attempt, 2);
    assertError(await f.submit({ metadata: DECLARATION }), 409, 'lease_lost');
    assert.equal((await f.row()).result_json, null);
    const second = { ...DECLARATION, wrapperVersion: '0.4.0', wrapperRevision: 'c'.repeat(40) };
    assert.equal((await f.submit({ metadata: second, leaseToken: retry.leaseToken })).status, 200);
    const accepted = await f.row();
    assert.equal(accepted.attempt, 2);
    assert.equal(JSON.parse(accepted.result_json).tcp.executionMetadata.wrapperVersion, '0.4.0');
    assertError(await f.submit({ metadata: DECLARATION }), 409, 'lease_lost');
    assert.deepEqual(await f.row(), accepted);
});

test('revoked HTTP identity cannot submit or replay and cancellation preserves completed snapshots', async () => {
    const f = await fixture();
    assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
    const accepted = await f.row();
    await f.store.cancel(f.job.id);
    assert.equal((await f.submit({ metadata: DECLARATION })).body.data.replay, true);
    await f.store.revokeAgent(f.agent.id);
    assertError(await f.submit({ metadata: DECLARATION }), 401, 'unauthorized');
    assert.deepEqual(await f.row(), accepted);
});

test('queued results expose null metadata and retention removes snapshots with their tasks', async () => {
    const queued = await fixture(['tcp'], { claim: false });
    for (const record of await queued.reads()) assertPublicRecord(record, null, null);
    const f = await fixture();
    assert.equal((await f.submit({ metadata: DECLARATION })).status, 200);
    f.advance(PROBE_RETENTION_DAYS * 86400000 + 1);
    const history = await f.call(`agents/${f.agent.id}/history`, undefined, { admin: true });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.data.records, []);
    assert.equal(history.body.data.total, 0);
    assert.equal(await f.row(), null);
    assertError(await f.call(`jobs/${f.job.id}`, undefined, { admin: true }), 404, 'job_not_found');
});
