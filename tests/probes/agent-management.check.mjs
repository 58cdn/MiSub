import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-helper.mjs';
import {
    ProbeStore,
    PROBE_AGENT_ONLINE_WINDOW_MS,
    PROBE_RETENTION_DAYS,
} from '../../functions/services/probe-store.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { digest, normalizeOptions } from '../../functions/services/probe-contract.js';

const origin = 'https://misub.example';
const base = `${origin}/api/probes/v1/`;
const admin = { 'x-test-admin': 'yes', Origin: origin };
const node = {
    id: 'fixture-node',
    name: 'Fixture node',
    proxy: { type: 'trojan', server: 'example.com', port: 443, password: 'private-node-password' },
    format: { status: 'passed', code: 'ok' },
};
async function fixture() {
    let now = 1791800000000;
    const env = { MISUB_PROBE_DB: database() };
    const store = await new ProbeStore(env.MISUB_PROBE_DB, () => now).init();
    const handle = createProbeHandler({
        authorizeAdmin: async (request) => request.headers.get('x-test-admin') === 'yes',
        prepareNodes: async () => [node],
        loadManualNodes: async () => [node],
        makeStore: () => store,
    });
    const request = (path, headers = admin, method = 'GET') =>
        new Request(base + path, { method, headers });
    const read = async (path) => {
        const response = await handle(request(path), env);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        return (await response.json()).data;
    };
    const job = (agentIds, key, nodes = [node]) =>
        store.createJob(
            {
                nodes,
                agentIds,
                ...normalizeOptions({ types: ['tcp'] }, nodes.length, agentIds.length),
            },
            key
        );
    return {
        env,
        store,
        handle,
        request,
        read,
        job,
        now: () => now,
        advance: (ms) => {
            now += ms;
        },
    };
}

test('empty management pages keep the existing detector array endpoint compatible', async () => {
    const { read, now } = await fixture();
    assert.deepEqual(await read('agents'), []);
    assert.deepEqual(await read('agents/overview'), {
        agents: [],
        total: 0,
        nextOffset: null,
        checkedAt: now(),
        onlineWindowMs: 120000,
        retentionDays: 7,
    });
});

test('detector status uses server communication time, a two-minute inclusive window, and revocation', async () => {
    const { store, now, advance } = await fixture();
    const a = await store.addAgent('Fixture');
    const current = async () => (await store.agentsOverview()).agents[0];
    assert.equal((await current()).status, 'unknown');
    assert.equal((await current()).lastSeen, 0);
    assert.equal((await current()).lastTaskAt, null);
    assert.equal((await current()).lastResultAt, null);
    assert.deepEqual((await current()).taskCounts, { queued: 0, running: 0, done: 0, stopped: 0 });
    await store.claim(a, { version: '0.2.0', platform: 'linux-amd64', observationsVersion: 1 });
    const seen = now();
    assert.equal((await current()).status, 'online');
    assert.equal((await current()).version, '0.2.0');
    assert.equal((await current()).platform, 'linux-amd64');
    assert.equal((await current()).capabilities, null);
    assert.equal((await current()).lastHeartbeatAt, null);
    advance(PROBE_AGENT_ONLINE_WINDOW_MS);
    assert.equal((await current()).status, 'online');
    assert.equal((await current()).lastSeen, seen);
    advance(1);
    assert.equal((await current()).status, 'offline');
    await store.q('UPDATE probe_agents SET last_seen=? WHERE id=?', now() + 1, a.id).run();
    assert.equal((await current()).status, 'unknown');
    await store.q('UPDATE probe_agents SET last_seen=? WHERE id=?', -1, a.id).run();
    assert.equal((await current()).status, 'unknown');
    await store.revokeAgent(a.id);
    assert.equal((await current()).status, 'revoked');
});

test('overview defaults to createdAt descending with stable identity tie-breaking', async () => {
    const { store, read, advance } = await fixture();
    const active = [await store.addAgent('A'), await store.addAgent('B')].sort((a, b) =>
        a.id.localeCompare(b.id)
    );
    advance(1);
    const retired = await store.addAgent('Retired');
    await store.revokeAgent(retired.id);
    const first = await read('agents/overview?limit=1');
    assert.equal(first.total, 3);
    assert.equal(first.agents[0].id, retired.id);
    assert.equal(first.nextOffset, 1);
    const second = await read('agents/overview?limit=1&offset=1');
    assert.equal(second.agents[0].id, active[0].id);
    assert.equal(second.nextOffset, 2);
    const third = await read('agents/overview?limit=1&offset=2');
    assert.equal(third.agents[0].id, active[1].id);
    assert.equal(third.nextOffset, null);
    assert.deepEqual((await read('agents/overview?offset=100000&limit=50')).agents, []);
    assert.equal((await read('agents/overview?offset=100000&limit=50')).nextOffset, null);
});

test('persisted task history separates creation and result receipt, preserves failed checks, and omits secrets', async () => {
    const { store, job, read, advance, now } = await fixture();
    const a = await store.addAgent('A');
    const b = await store.addAgent('B');
    const firstJob = await job([a.id, b.id], 'history-job-1');
    const createdAt = now();
    const t = await store.claim(a);
    advance(1000);
    await store.finish(a, t.id, t.leaseToken, {
        tcp: { status: 'failed', code: 'connect_failed', raw: 'private-node-password' },
    });
    const completedAt = now();
    advance(1000);
    const secondJob = await job([a.id], 'history-job-2');
    const secondCreatedAt = now();
    const history = await read(`agents/${a.id}/history?limit=1`);
    assert.equal(history.total, 2);
    assert.equal(history.nextOffset, 1);
    assert.equal(history.agent.lastTaskAt, secondCreatedAt);
    assert.equal(history.agent.lastResultAt, completedAt);
    assert.deepEqual(history.agent.taskCounts, { queued: 1, running: 0, done: 1, stopped: 0 });
    assert.deepEqual(history.records, [
        {
            id: `${secondJob.id}_${a.id}_0`,
            jobId: secondJob.id,
            nodeId: node.id,
            nodeName: node.name,
            state: 'queued',
            attempt: 0,
            createdAt: secondCreatedAt,
            completedAt: null,
            checks: null,
            executionMetadata: null,
        },
    ]);
    const completed = await read(`agents/${a.id}/history?offset=1&limit=1`);
    assert.equal(completed.nextOffset, null);
    assert.deepEqual(completed.records, [
        {
            id: t.id,
            jobId: firstJob.id,
            nodeId: node.id,
            nodeName: node.name,
            state: 'done',
            attempt: 1,
            createdAt,
            completedAt,
            checks: { tcp: { status: 'failed', code: 'connect_failed' } },
            executionMetadata: null,
        },
    ]);
    assert.equal((await read(`agents/${b.id}/history`)).total, 1);
    const serialized = JSON.stringify([history, completed, await read('agents/overview')]);
    for (const sensitive of [
        a.token,
        b.token,
        t.leaseToken,
        await digest(a.token),
        await digest(t.leaseToken),
        'private-node-password',
        'node_payload',
        'token_hash',
        'lease_hash',
        'lease_until',
        'result_hash',
    ]) {
        assert.ok(
            !serialized.includes(sensitive),
            `Unexpected sensitive field or value: ${sensitive.slice(0, 10)}`
        );
    }
});

test('history paginates equal-time tasks in stable order and unknown identities return 404', async () => {
    const { store, job, read, handle, request, env } = await fixture();
    const a = await store.addAgent('A');
    await job([a.id], 'equal-time-1', [node, { ...node, id: 'second', name: 'Second' }]);
    const first = await read(`agents/${a.id}/history?limit=1`);
    const second = await read(`agents/${a.id}/history?limit=1&offset=1`);
    assert.ok(first.records[0].id < second.records[0].id);
    assert.equal(first.nextOffset, 1);
    assert.equal(second.nextOffset, null);
    const response = await handle(request('agents/missing/history'), env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'agent_not_found');
});

test('revocation retains history and records cancellation separately from received results', async () => {
    const { store, job, read } = await fixture();
    const a = await store.addAgent('A');
    await job([a.id], 'revoke-history', [node, { ...node, id: 'second' }]);
    await store.claim(a);
    assert.deepEqual((await read('agents/overview')).agents[0].taskCounts, {
        queued: 1,
        running: 1,
        done: 0,
        stopped: 0,
    });
    await store.revokeAgent(a.id);
    const history = await read(`agents/${a.id}/history`);
    assert.equal(history.agent.status, 'revoked');
    assert.equal(history.agent.lastResultAt, null);
    assert.deepEqual(history.agent.taskCounts, { queued: 0, running: 0, done: 0, stopped: 2 });
    assert.ok(
        history.records.every(
            (record) =>
                record.state === 'cancelled' &&
                record.completedAt !== null &&
                record.checks === null
        )
    );
});

test('management reads apply seven-day retention and expiration without inventing result receipt', async () => {
    const { store, job, read, advance } = await fixture();
    const a = await store.addAgent('A');
    await job([a.id], 'retention-history');
    advance(PROBE_RETENTION_DAYS * 86400000);
    const atBoundary = await read(`agents/${a.id}/history`);
    assert.equal(atBoundary.total, 1);
    assert.equal(atBoundary.records[0].state, 'expired');
    assert.equal(atBoundary.agent.lastResultAt, null);
    advance(1);
    const afterBoundary = await read(`agents/${a.id}/history`);
    assert.equal(afterBoundary.total, 0);
    assert.equal(afterBoundary.agent.lastTaskAt, null);
    assert.equal(afterBoundary.agent.lastResultAt, null);
    assert.deepEqual(afterBoundary.records, []);
    assert.equal((await read('agents/overview')).total, 1);
});

test('management pagination accepts only bounded canonical decimal query values', async () => {
    const { store, handle, request, env } = await fixture();
    const a = await store.addAgent('A');
    const queries = [
        'offset=-1',
        'offset=1e2',
        'offset=1.0',
        'offset=NaN',
        'offset=Infinity',
        'offset=+1',
        'offset=01',
        'offset=',
        'offset=%200',
        'offset=100001',
        'offset=9007199254740993',
        'offset=0&offset=1',
        'limit=0',
        'limit=51',
        'limit=1.0',
        'limit=1e1',
        'limit=',
        'limit=01',
        'limit=1&limit=2',
    ];
    for (const path of ['agents/overview', `agents/${a.id}/history`]) {
        for (const query of queries) {
            const response = await handle(request(`${path}?${query}`), env);
            assert.equal(response.status, 400, `${path}?${query}`);
            assert.match((await response.json()).error.code, /^invalid_(offset|limit)$/);
        }
    }
    await assert.rejects(store.agentsOverview(NaN, 20), /invalid_offset/);
    await assert.rejects(store.agentHistory(a.id, 0, 51), /invalid_limit/);
});

test('management reads require admin auth and detector credentials do not grant access', async () => {
    const { store, handle, request, env, read } = await fixture();
    const a = await store.addAgent('A');
    for (const path of ['agents/overview', `agents/${a.id}/history`]) {
        for (const headers of [
            {},
            { Authorization: `Bearer ${a.token}` },
            { Origin: 'https://foreign.example' },
        ]) {
            const response = await handle(request(path, headers), env);
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), {
                success: false,
                error: { code: 'unauthorized' },
            });
        }
        assert.ok(await read(path));
    }
    for (const Origin of [undefined, 'https://foreign.example']) {
        const headers = { 'x-test-admin': 'yes' };
        if (Origin) headers.Origin = Origin;
        assert.equal((await handle(request(`agents/${a.id}`, headers, 'DELETE'), env)).status, 403);
        assert.equal((await read('agents/overview')).agents[0].status, 'unknown');
    }
    const revoked = await handle(request(`agents/${a.id}`, admin, 'DELETE'), env);
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).data.revoked, true);
    await assert.rejects(store.authenticate(a.token), /unauthorized/);
    assert.equal((await read(`agents/${a.id}/history`)).agent.status, 'revoked');
});

test('unauthenticated management requests never initialize storage', async () => {
    let touched = false;
    const handle = createProbeHandler({
        authorizeAdmin: async () => false,
        makeStore: () => {
            touched = true;
            throw new Error('unreachable');
        },
    });
    for (const path of ['agents/overview', 'agents/fixture/history']) {
        assert.equal((await handle(new Request(base + path), {})).status, 401);
    }
    assert.equal(touched, false);
});

test('history state filters paginate persisted records and count only matching tasks for the chosen identity', async () => {
    const { store, job, read, advance } = await fixture();
    const a = await store.addAgent('A');
    const b = await store.addAgent('B');
    await job([a.id], 'filter-expired');
    advance(86400001);
    await store.sweep();
    const completed = [];
    for (let i = 0; i < 3; i++) {
        advance(1);
        await job([a.id], `filter-done-${i}`);
        const task = await store.claim(a);
        advance(1);
        await store.finish(a, task.id, task.leaseToken, {
            tcp: { status: 'failed', code: 'connect_failed' },
        });
        completed.unshift(task.id);
    }
    const cancelled = await job([a.id], 'filter-cancelled');
    await store.cancel(cancelled.id);
    await job([a.id], 'filter-running');
    const running = await store.claim(a);
    await job([a.id], 'filter-queued', [node, { ...node, id: 'second' }]);
    await job([b.id], 'filter-other-identity');
    const first = await read(`agents/${a.id}/history?state=done&limit=2`);
    const second = await read(`agents/${a.id}/history?state=done&limit=2&offset=2`);
    assert.equal(first.total, 3);
    assert.equal(first.nextOffset, 2);
    assert.equal(second.total, 3);
    assert.equal(second.nextOffset, null);
    assert.deepEqual([...first.records, ...second.records].map(record => record.id), completed);
    assert.deepEqual(first.agent.taskCounts, { queued: 2, running: 1, done: 3, stopped: 2 });
    const pages = [first, second];
    for (const [state, count] of Object.entries({ queued: 2, running: 1, done: 3, cancelled: 1, expired: 1 })) {
        const page = await read(`agents/${a.id}/history?state=${state}`);
        assert.equal(page.total, count, state);
        assert.equal(page.records.length, count, state);
        assert.equal(page.nextOffset, null);
        assert.ok(page.records.every(record => record.state === state));
        pages.push(page);
    }
    assert.equal((await read(`agents/${a.id}/history`)).total, 8);
    assert.equal((await read(`agents/${b.id}/history?state=queued`)).total, 1);
    const serialized = JSON.stringify(pages);
    for (const sensitive of [
        a.token, b.token, running.leaseToken, await digest(a.token), await digest(running.leaseToken),
        'private-node-password', 'node_payload', 'token_hash', 'lease_hash', 'lease_until',
    ]) {
        assert.ok(!serialized.includes(sensitive));
    }
});

test('filtered history has a true empty state and still obeys seven-day retention', async () => {
    const { store, job, read, advance } = await fixture();
    const a = await store.addAgent('A');
    await job([a.id], 'filter-retention');
    const missing = await read(`agents/${a.id}/history?state=done`);
    assert.equal(missing.total, 0);
    assert.equal(missing.nextOffset, null);
    assert.deepEqual(missing.records, []);
    assert.equal(missing.agent.taskCounts.queued, 1);
    const beyond = await read(`agents/${a.id}/history?state=queued&offset=1`);
    assert.equal(beyond.total, 1);
    assert.equal(beyond.nextOffset, null);
    assert.deepEqual(beyond.records, []);
    advance(PROBE_RETENTION_DAYS * 86400000);
    assert.equal((await read(`agents/${a.id}/history?state=expired`)).total, 1);
    advance(1);
    const removed = await read(`agents/${a.id}/history?state=expired`);
    assert.equal(removed.total, 0);
    assert.equal(removed.nextOffset, null);
    assert.deepEqual(removed.records, []);
});

test('history rejects empty, unknown, duplicate and injection-shaped state values', async () => {
    const { store, handle, request, env } = await fixture();
    const a = await store.addAgent('A');
    for (const query of [
        'state=', 'state=all', 'state=unknown', 'state=stopped', 'state=Done', 'state=done%20',
        'state=+done', 'state=done,queued', 'state=done&state=done', 'state=queued&state=done',
        'state=done%27%20OR%201%3D1--',
    ]) {
        const response = await handle(request(`agents/${a.id}/history?${query}`), env);
        assert.equal(response.status, 400, query);
        assert.deepEqual(await response.json(), { success: false, error: { code: 'invalid_state' } });
    }
    for (const state of ['', 'all', 'done\' OR 1=1--', ['done'], 0]) {
        await assert.rejects(store.agentHistory(a.id, 0, 20, state), /invalid_state/);
    }
    const unauthorized = await handle(request(`agents/${a.id}/history?state=done`, {
        Authorization: `Bearer ${a.token}`,
    }), env);
    assert.equal(unauthorized.status, 401);
});
