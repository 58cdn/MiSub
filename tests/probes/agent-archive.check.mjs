import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-helper.mjs';
import { ProbeStore, PROBE_SCHEMA, PROBE_RETENTION_DAYS } from '../../functions/services/probe-store.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { normalizeOptions } from '../../functions/services/probe-contract.js';

const origin = 'https://misub.example';
const admin = { 'x-fixture-admin': 'yes', Origin: origin, 'Content-Type': 'application/json' };
const node = { id: 'fixture-node', name: 'Fixture', proxy: { type: 'trojan', server: 'example.com', port: 443, password: 'private-fixture-password' }, format: { status: 'passed', code: 'ok' } };

async function fixture() {
    let now = 1791800000000;
    let storeCalls = 0;
    const db = database();
    const store = await new ProbeStore(db, () => now).init();
    const env = { MISUB_PROBE_DB: db };
    const handler = createProbeHandler({
        authorizeAdmin: async request => request.headers.get('x-fixture-admin') === 'yes',
        prepareNodes: async () => [node], loadManualNodes: async () => [node],
        makeStore: () => { storeCalls++; return store; }
    });
    const request = async (path, { method = 'GET', headers = admin, body } = {}) => {
        const response = await handler(new Request(`${origin}/api/probes/v1/${path}`, {
            method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
        }), env);
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const action = (id, name = 'archive', options = {}) => request(`agents/${id}/${name}`, { method: 'POST', body: { confirmed: true }, ...options });
    const job = (id, key) => store.createJob({ nodes: [node], agentIds: [id], ...normalizeOptions({ types: ['tcp'] }, 1, 1) }, key);
    return { db, store, request, action, job, now: () => now, advance: ms => { now += ms; }, storeCalls: () => storeCalls };
}

test('archive is recoverable visibility metadata and preserves revoked credentials, results and attribution', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Fixture');
    const job = await f.job(agent.id, 'archive-history-1');
    const task = await f.store.claim(agent);
    await f.store.finish(agent, task.id, task.leaseToken, { tcp: { status: 'passed', code: 'ok', latencyMs: 15 } });
    await f.store.revokeAgent(agent.id);
    const before = await f.store.agentHistory(agent.id);
    const archived = await f.action(agent.id);
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.body.data, { id: agent.id, hidden: true, archivedAt: f.now(), restoredAt: null });
    assert.equal(archived.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await f.store.agents(), []);
    assert.equal((await f.store.agentsOverview()).total, 0);
    const hidden = await f.store.agentsOverview(0, 20, { visibility: 'hidden' });
    assert.equal(hidden.total, 1);
    assert.equal(hidden.agents[0].status, 'revoked');
    assert.equal(hidden.agents[0].hidden, true);
    assert.equal(hidden.agents[0].capabilities, null);
    assert.equal(hidden.agents[0].lastHeartbeatAt, null);
    const history = await f.store.agentHistory(agent.id);
    assert.deepEqual(history.records, before.records);
    assert.equal(history.agent.hidden, true);
    assert.equal((await f.store.results(job.id)).nodes[0].agent_name, 'Fixture');
    f.advance(50);
    const restored = await f.action(agent.id, 'restore');
    assert.deepEqual(restored.body.data, { id: agent.id, hidden: false, archivedAt: archived.body.data.archivedAt, restoredAt: f.now() });
    assert.equal((await f.store.agents()).length, 1);
    assert.equal((await f.store.agentsOverview()).agents[0].status, 'revoked');
    assert.deepEqual((await f.store.agentHistory(agent.id)).records, before.records);
    await assert.rejects(f.store.authenticate(agent.token), /unauthorized/);
    await assert.rejects(f.job(agent.id, 'archived-no-enqueue'), /agent_unavailable/);
    const output = JSON.stringify([hidden, history, archived.body, restored.body]);
    for (const secret of [agent.token, task.leaseToken, 'private-fixture-password', 'token_hash', 'lease_hash', 'node_payload']) assert.ok(!output.includes(secret), secret);
});

test('archive and restore retries retain transition timestamps; never-archived restore is a no-op', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Revoked');
    await f.store.revokeAgent(agent.id);
    assert.deepEqual(await f.store.archiveAgent(agent.id, false), { id: agent.id, hidden: false, archivedAt: null, restoredAt: null });
    assert.equal(await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first(), null);
    const archived = await f.store.archiveAgent(agent.id);
    f.advance(100);
    assert.deepEqual(await f.store.archiveAgent(agent.id), archived);
    const restored = await f.store.archiveAgent(agent.id, false);
    f.advance(100);
    assert.deepEqual(await f.store.archiveAgent(agent.id, false), restored);
    const again = await f.store.archiveAgent(agent.id);
    assert.equal(again.archivedAt, f.now());
    assert.equal(again.hidden, true);
    assert.equal(again.restoredAt, null);
});

test('only revoked identities may be archived or restored and unknown identities remain 404', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Active');
    for (const name of ['archive', 'restore']) {
        const active = await f.action(agent.id, name);
        assert.equal(active.status, 409);
        assert.equal(active.body.error.code, 'agent_must_be_revoked');
        const absent = await f.action('missing', name);
        assert.equal(absent.status, 404);
        assert.equal(absent.body.error.code, 'agent_not_found');
    }
    assert.equal((await f.store.agents()).length, 1);
    await assert.rejects(f.store.archiveAgent(agent.id, 'true'), /invalid_archive_action/);
});

test('a live running lease blocks archive atomically, including repeated archive, and equality means expired', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Lease');
    await f.job(agent.id, 'archive-live-lease');
    const task = await f.store.claim(agent);
    // Represent a persisted revoked identity with an outstanding legacy lease.
    await f.store.q('UPDATE probe_agents SET revoked_at=? WHERE id=?', f.now(), agent.id).run();
    await assert.rejects(f.store.archiveAgent(agent.id), /agent_has_active_lease/);
    assert.equal(await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first(), null);
    await f.store.q('UPDATE probe_tasks SET lease_until=? WHERE id=?', f.now(), task.id).run();
    const archived = await f.store.archiveAgent(agent.id);
    await f.store.q('UPDATE probe_tasks SET lease_until=? WHERE id=?', f.now() + 1, task.id).run();
    await assert.rejects(f.store.archiveAgent(agent.id), /agent_has_active_lease/);
    const row = await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first();
    assert.equal(row.archived_at, archived.archivedAt);
    assert.equal(row.restored_at, null);
});

test('lease introduced after the preliminary identity read cannot bypass the archive SQL condition', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Race');
    await f.job(agent.id, 'archive-race-lease');
    const task = await f.store.claim(agent);
    await f.store.revokeAgent(agent.id);
    const original = f.store.q.bind(f.store);
    let injected = false;
    f.store.q = (sql, ...params) => {
        const statement = original(sql, ...params);
        if (!sql.startsWith('INSERT INTO probe_agent_archives')) return statement;
        return { ...statement, first: async () => {
            injected = true;
            await original("UPDATE probe_tasks SET state='running',lease_until=? WHERE id=?", f.now() + 500, task.id).run();
            return statement.first();
        } };
    };
    await assert.rejects(f.store.archiveAgent(agent.id), /agent_has_active_lease/);
    assert.equal(injected, true);
    assert.equal(await original('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first(), null);
});

test('concurrent archive retries create one row and overlapping restore responses reflect their own atomic transitions', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Concurrent');
    await f.store.revokeAgent(agent.id);
    const replies = await Promise.all(Array.from({ length: 12 }, () => f.store.archiveAgent(agent.id)));
    for (const reply of replies) assert.deepEqual(reply, replies[0]);
    assert.equal((await f.store.q('SELECT COUNT(*) AS n FROM probe_agent_archives').first()).n, 1);
    const [archived, restored] = await Promise.all([f.store.archiveAgent(agent.id), f.store.archiveAgent(agent.id, false)]);
    assert.equal(archived.hidden, true);
    assert.equal(restored.hidden, false);
    assert.equal((await f.store.agentsOverview()).total, 1);
    assert.equal((await f.store.agentHistory(agent.id)).agent.status, 'revoked');
});

test('SQLite statement failure rolls back archive and restore while preserving identity and tasks', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('Rollback');
    await f.job(agent.id, 'archive-rollback-job');
    await f.store.revokeAgent(agent.id);
    const before = await f.store.agentHistory(agent.id);
    await f.store.q("CREATE TRIGGER fail_archive AFTER INSERT ON probe_agent_archives BEGIN SELECT RAISE(ABORT,'fixture_failure'); END").run();
    assert.equal((await f.action(agent.id)).status, 503);
    assert.equal(await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first(), null);
    await f.store.q('DROP TRIGGER fail_archive').run();
    const archived = await f.store.archiveAgent(agent.id);
    await f.store.q("CREATE TRIGGER fail_restore AFTER UPDATE ON probe_agent_archives BEGIN SELECT RAISE(ABORT,'fixture_failure'); END").run();
    assert.equal((await f.action(agent.id, 'restore')).status, 503);
    const row = await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first();
    assert.equal(row.restored_at, null);
    assert.equal(row.archived_at, archived.archivedAt);
    assert.deepEqual((await f.store.agentHistory(agent.id)).records, before.records);
    assert.equal((await f.store.agentHistory(agent.id)).agent.revokedAt, before.agent.revokedAt);
});

test('existing schema data survives archive-table initialization and archived history keeps seven-day retention', async () => {
    const db = database();
    await db.batch(PROBE_SCHEMA.slice(0, -1).map(sql => db.prepare(sql)));
    await db.prepare('INSERT INTO probe_agents(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind('existing', 'Existing', 'fixture-hash', 1).run();
    const migrated = await new ProbeStore(db).init();
    assert.equal((await migrated.agents())[0].id, 'existing');
    const f = await fixture();
    const agent = await f.store.addAgent('Retained identity');
    await f.job(agent.id, 'archive-retention-job');
    await f.store.revokeAgent(agent.id);
    await f.store.archiveAgent(agent.id);
    f.advance(PROBE_RETENTION_DAYS * 86400000 + 1);
    const history = await f.store.agentHistory(agent.id);
    assert.equal(history.records.length, 0);
    assert.equal(history.agent.hidden, true);
    assert.equal(history.agent.status, 'revoked');
    assert.equal((await f.store.agentsOverview(0, 20, { visibility: 'hidden' })).total, 1);
});

test('overview filters search literal SQL wildcard characters across persisted name/version/platform', async () => {
    const f = await fixture();
    const percent = await f.store.addAgent('Rate 100%');
    const underscore = await f.store.addAgent('Under_score');
    const ordinary = await f.store.addAgent('Plain');
    await f.store.claim(percent, { version: '0.2.0', platform: 'linux-amd64' });
    await f.store.claim(underscore, { version: '0.1.0', platform: 'darwin-arm64' });
    const search = async q => (await f.request('agents/overview?' + new URLSearchParams({ q }))).body.data;
    assert.deepEqual((await search('%')).agents.map(x => x.id), [percent.id]);
    assert.deepEqual((await search('_')).agents.map(x => x.id), [underscore.id]);
    assert.deepEqual((await search(' DARWIN ')).agents.map(x => x.id), [underscore.id]);
    assert.deepEqual((await search('0.2.0')).agents.map(x => x.id), [percent.id]);
    assert.equal((await search("' OR 1=1--")).total, 0);
    await f.store.revokeAgent(percent.id);
    await f.store.archiveAgent(percent.id);
    const hidden = (await f.request('agents/overview?visibility=hidden&q=%25&status=revoked')).body.data;
    assert.equal(hidden.total, 1);
    assert.equal(hidden.agents[0].id, percent.id);
    assert.equal((await search('%')).total, 0);
    assert.equal((await f.store.agentsOverview(0, 20, { status: 'unknown' })).agents[0].id, ordinary.id);
});

test('overview status predicates agree with returned status for invalid, future, boundary and revoked timestamps', async () => {
    const f = await fixture();
    const agents = [];
    for (const [name, value] of [['zero', 0], ['negative', -1], ['future', f.now() + 1], ['fractional', f.now() - 0.5], ['text', 'not-a-time'], ['boundary', f.now() - 120000], ['offline', f.now() - 120001]]) {
        const agent = await f.store.addAgent(name);
        await f.store.q('UPDATE probe_agents SET last_seen=? WHERE id=?', value, agent.id).run();
        agents.push(agent);
    }
    await f.store.revokeAgent(agents[0].id);
    for (const status of ['online', 'offline', 'unknown', 'revoked']) {
        const result = await f.store.agentsOverview(0, 50, { status });
        assert.ok(result.agents.every(agent => agent.status === status));
        assert.equal(result.total, { online: 1, offline: 1, unknown: 4, revoked: 1 }[status]);
    }
});

test('filtered server pagination applies all sort keys, direction and stable identity tie-breaking', async () => {
    const f = await fixture();
    const a = await f.store.addAgent('Bravo');
    f.advance(10);
    const b = await f.store.addAgent('Alpha');
    f.advance(10);
    const c = await f.store.addAgent('Charlie');
    await f.store.claim(a, { version: '2.0.0' });
    await f.job(a.id, 'archive-sort-first');
    const first = await f.store.claim(a, { version: '2.0.0' });
    await f.store.finish(a, first.id, first.leaseToken, { tcp: { status: 'failed', code: 'connect_failed' } });
    f.advance(10);
    await f.store.claim(b, { version: '1.0.0' });
    await f.job(b.id, 'archive-sort-second');
    const second = await f.store.claim(b, { version: '1.0.0' });
    await f.store.finish(b, second.id, second.leaseToken, { tcp: { status: 'passed', code: 'ok' } });
    const expectedAscending = {
        createdAt: [a.id, b.id, c.id], name: [b.id, a.id, c.id],
        status: [a.id, b.id].sort().concat(c.id),
        lastSeen: [a.id, b.id, c.id], lastTaskAt: [a.id, b.id, c.id], lastResultAt: [a.id, b.id, c.id],
        version: [b.id, a.id, c.id]
    };
    for (const [sort, expected] of Object.entries(expectedAscending)) {
        const page = await f.store.agentsOverview(0, 50, { sort, direction: 'asc' });
        assert.deepEqual(page.agents.map(x => x.id), expected, sort);
    }
    const desc = await f.store.agentsOverview(0, 50, { sort: 'lastResultAt', direction: 'desc' });
    assert.deepEqual(desc.agents.map(x => x.id), [b.id, a.id, c.id]);
    for (const agent of [a, b]) await f.store.revokeAgent(agent.id);
    const page1 = await f.store.agentsOverview(0, 1, { status: 'revoked', sort: 'name', direction: 'asc' });
    const page2 = await f.store.agentsOverview(page1.nextOffset, 1, { status: 'revoked', sort: 'name', direction: 'asc' });
    assert.equal(page1.total, 2);
    assert.deepEqual([page1.agents[0].id, page2.agents[0].id], [b.id, a.id]);
    assert.equal(page2.nextOffset, null);
    assert.equal((await f.store.agentsOverview(20, 1, { status: 'revoked' })).nextOffset, null);
});

test('overview rejects unknown, duplicate, coerced and injection-shaped query parameters', async () => {
    const f = await fixture();
    const queries = ['unknown=x', 'q=a&q=b', 'status=all&status=online', 'visibility=all&visibility=hidden', 'sort=name&sort=status', 'direction=asc&direction=desc', 'status=invalid', 'visibility=', 'sort=name%20DESC%3BDROP%20TABLE%20probe_agents', 'direction=ASC', 'q=' + 'a'.repeat(81), 'q=%00', 'offset=1e2', 'limit=2&limit=3'];
    for (const query of queries) {
        const response = await f.request('agents/overview?' + query);
        assert.equal(response.status, 400, query);
    }
    for (const input of [{ q: [] }, { status: 1 }, { visibility: true }, { sort: {} }, { direction: null }]) await assert.rejects(f.store.agentsOverview(0, 20, input));
});

test('archive and restore enforce admin auth, same-origin, small JSON and exact confirmation before mutation', async () => {
    const f = await fixture();
    const agent = await f.store.addAgent('HTTP');
    await f.store.revokeAgent(agent.id);
    const calls = f.storeCalls();
    for (const headers of [{ Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json' }, { Cookie: 'auth_session=wrong', Origin: origin, 'Content-Type': 'application/json' }]) {
        assert.equal((await f.action(agent.id, 'archive', { headers })).status, 401);
    }
    assert.equal((await f.action(agent.id, 'archive', { headers: { ...admin, Origin: 'https://other.example' } })).status, 403);
    const { Origin: omitted, ...noOrigin } = admin;
    assert.equal((await f.action(agent.id, 'restore', { headers: noOrigin })).status, 403);
    assert.equal(f.storeCalls(), calls);
    for (const body of [{}, { confirmed: false }, { confirmed: 'true' }, { confirmed: true, extra: 1 }, [], 'null', '{']) {
        assert.equal((await f.action(agent.id, 'archive', { body })).status, 400);
    }
    assert.equal((await f.action(agent.id, 'archive', { body: ' '.repeat(257) })).status, 413);
    assert.equal((await f.action(agent.id, 'archive', { headers: { ...admin, 'Content-Length': '257' } })).status, 413);
    assert.equal((await f.action(agent.id, 'archive', { headers: { ...admin, 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await f.request(`agents/${agent.id}/archive?extra=1`, { method: 'POST', body: { confirmed: true } })).status, 400);
    assert.equal(await f.store.q('SELECT * FROM probe_agent_archives WHERE agent_id=?', agent.id).first(), null);
    const archived = await f.action(agent.id);
    assert.equal(archived.status, 200);
    const denied = await f.action(agent.id, 'restore', { body: { confirmed: false } });
    assert.equal(denied.status, 400);
    assert.equal((await f.store.agentHistory(agent.id)).agent.hidden, true);
});
