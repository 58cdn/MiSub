import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-helper.mjs';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { ProbePairingStore } from '../../functions/services/probe-pairing-store.js';
import { digest, randomToken } from '../../functions/services/probe-contract.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';

const origin = 'https://misub.example';
const otherOrigin = 'https://preview.example';
const missingId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const admin = { 'x-test-admin': 'yes', Origin: origin };
async function fixture(initialize = true) {
    let now = 1791800040000;
    const db = database();
    const store = new ProbeStore(db, () => now);
    if (initialize) await store.init();
    const pairing = new ProbePairingStore(db, () => now);
    const env = { MISUB_PROBE_DB: db };
    const handle = createProbeHandler({ authorizeAdmin: async request => request.headers.get('x-test-admin') === 'yes', makeStore: () => store });
    async function http(path, body, headers = admin, site = origin) {
        const response = await handle(new Request(`${site}/api/probes/v1/${path}`, {
            method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        }), env);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        return { status: response.status, headers: response.headers, ...(await response.json()) };
    }
    async function start(name = 'Fixture detector', window = null) {
        window ??= await pairing.createWindow(origin);
        const proof = randomToken();
        const input = { windowId: window.id, name, version: '0.2.0', platform: 'linux-amd64', proofHash: await digest(proof) };
        const started = await pairing.start(input, origin);
        return { window, input, started, proof, poll: { windowId: window.id, id: started.id, deviceCode: started.deviceCode, proof } };
    }
    return { db, store, pairing, http, start, now: () => now, advance: ms => { now += ms; } };
}

test('device pairing requires explicit approval and returns a site-bound credential only to the native client', async () => {
    const { pairing, store, http, start, advance, now } = await fixture();
    const enrollment = await start();
    const { started, proof, input, poll, window } = enrollment;
    assert.match(started.userCode, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.match(started.deviceCode, /^pdc1_[0-9a-f]{64}$/);
    assert.equal(started.fingerprint, input.proofHash.slice(0, 16).toUpperCase().match(/.{4}/g).join('-'));
    assert.equal(started.expiresAt, window.expiresAt);
    advance(5000);
    const pending = await http('device-pairing/token', poll, {});
    assert.equal(pending.status, 202);
    assert.deepEqual(pending.data, { status: 'pending', expiresAt: window.expiresAt, intervalSeconds: 5 });
    const resolved = await http('pairings/resolve', { windowId: window.id, userCode: started.userCode.toLowerCase().replace('-', '') });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.status, 'pending');
    assert.equal((await http(`pairings/requests/${started.id}/approve`, { userCode: started.userCode, confirmed: false })).error.code, 'pairing_confirmation_required');
    const approved = await http(`pairings/requests/${started.id}/approve`, { userCode: started.userCode, confirmed: true });
    assert.equal(approved.data.status, 'approved');
    assert.equal((await http(`pairings/requests/${started.id}/approve`, { userCode: started.userCode, confirmed: true })).data.status, 'approved');
    advance(5000);
    const exchanged = await http('device-pairing/token', poll, {});
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.data.status, 'consumed');
    assert.equal(exchanged.data.config.server, origin);
    const token = exchanged.data.config.token;
    assert.equal((await store.authenticate(token, origin)).id, exchanged.data.agent.id);
    await assert.rejects(store.authenticate(token, otherOrigin), /unauthorized/);
    await assert.rejects(store.authenticate(token), /unauthorized/);
    assert.equal((await http('agent/claim', {}, { Authorization: `Bearer ${token}`, 'X-Forwarded-Host': 'misub.example' }, otherOrigin)).status, 401);
    const beforeClaim = await pairing.request(started.id, origin);
    assert.equal(beforeClaim.status, 'consumed');
    assert.equal(beforeClaim.lastSeen, 0);
    const claim = await http('agent/claim', { version: '0.2.0', platform: 'linux-amd64' }, { Authorization: `Bearer ${token}` });
    assert.equal(claim.status, 200);
    assert.equal((await pairing.request(started.id, origin)).lastSeen, now());
    const adminDtos = JSON.stringify([resolved.data, approved.data, await pairing.window(window.id, origin), await store.agentsOverview()]);
    for (const secret of [token, started.deviceCode, proof, input.proofHash, await digest(started.userCode.replace('-', '')), 'token_hash', 'device_hash', 'proof_hash', 'user_code_hash']) assert.ok(!adminDtos.includes(secret));
    const persisted = JSON.stringify([(await store.q('SELECT * FROM probe_pairings').all()).results, (await store.q('SELECT * FROM probe_agents').all()).results]);
    for (const secret of [token, started.deviceCode, proof, started.userCode, started.userCode.replace('-', '')]) assert.ok(!persisted.includes(secret));
});

test('public routes reject browser/auth headers before parsing bodies or touching any store', async () => {
    let touched = false;
    const handler = createProbeHandler({ authorizeAdmin: async () => false, makeStore: () => { touched = true; throw new Error('unexpected_storage_access'); } });
    for (const path of ['start', 'token', 'unknown']) {
        for (const headers of [{ Cookie: '' }, { Origin: origin }, { Authorization: 'Bearer fixture' }]) {
            const response = await handler(new Request(`${origin}/api/probes/v1/device-pairing/${path}`, { method: 'POST', headers, body: 'invalid json' }), {});
            assert.equal(response.status, 403);
            assert.equal((await response.json()).error.code, 'pairing_native_request_required');
        }
    }
    assert.equal(touched, false);
});

test('public requests never initialize storage and admin windows require session, origin and HTTPS', async () => {
    const { store, http } = await fixture(false);
    const input = { windowId: missingId, name: 'A', version: '1', platform: 'linux-amd64', proofHash: 'a'.repeat(64) };
    assert.equal((await http('device-pairing/start', input, {})).status, 503);
    assert.deepEqual((await store.q("SELECT name FROM sqlite_master WHERE type='table'").all()).results, []);
    assert.equal((await http('pairings/windows', {}, {})).status, 401);
    assert.equal((await http('pairings/windows', {}, { 'x-test-admin': 'yes' })).status, 403);
    assert.equal((await http('pairings/windows', {}, { ...admin, Origin: otherOrigin })).status, 403);
    assert.equal((await http('pairings/windows', {}, { ...admin, Origin: 'http://misub.example' }, 'http://misub.example')).status, 400);
    assert.deepEqual((await store.q("SELECT name FROM sqlite_master WHERE type='table'").all()).results, []);
    assert.equal((await http('pairings/windows', {})).status, 201);
});

test('pairing input and 8-KiB bodies fail closed without changing the general probe API', async () => {
    const { http, start } = await fixture();
    const { input, poll, started } = await start();
    for (const body of [{ ...input, secret: 'extra' }, { ...input, proofHash: 'invalid' }, { ...input, windowId: '../windows' }, { ...input, name: '\n' }, { ...input, version: '' }]) {
        assert.equal((await http('device-pairing/start', body, {})).error.code, 'invalid_pairing_request');
    }
    assert.equal((await http('device-pairing/token', { ...poll, proof: 'z'.repeat(64) }, {})).status, 400);
    assert.equal((await http(`pairings/requests/${started.id}/approve`, { userCode: started.userCode, confirmed: true, name: 'replacement' })).status, 400);
    assert.equal((await http('device-pairing/start', { ...input, name: 'x'.repeat(9000) }, {})).status, 413);
    assert.equal((await http('device-pairing/start', input, { 'Content-Length': '8193' })).status, 413);
    assert.equal((await http('device-pairing/start?extra=1&extra=2', input, {})).status, 400);
    assert.equal((await http('pairings/windows?extra=1', {})).status, 400);
    assert.equal((await http('device-pairing/start', input, { 'Content-Type': 'text/plain' })).status, 415);
});

test('wrong native secrets, unknown requests and other origins share the same safe error', async () => {
    const { http, start, pairing, advance } = await fixture();
    const { poll, started, window } = await start();
    await pairing.approve(started.id, started.userCode, true, origin);
    advance(5000);
    for (const [body, site] of [[{ ...poll, id: missingId }, origin], [{ ...poll, deviceCode: `pdc1_${'0'.repeat(64)}` }, origin], [{ ...poll, proof: '0'.repeat(64) }, origin], [poll, otherOrigin]]) {
        const response = await http('device-pairing/token', body, {}, site);
        assert.equal(response.status, 404);
        assert.deepEqual(response.error, { code: 'pairing_unavailable' });
    }
    assert.equal((await pairing.window(window.id, origin)).requests[0].status, 'approved');
    assert.equal((await http(`pairings/windows/${window.id}`, undefined, { ...admin, Origin: otherOrigin }, otherOrigin)).status, 404);
    assert.equal((await http('device-pairing/token', poll, { 'X-Forwarded-Host': 'misub.example' }, otherOrigin)).status, 404);
});

test('concurrent redemption creates exactly one identity and secret response; consumed replay never returns it', async () => {
    const { pairing, store, start, advance } = await fixture();
    const { poll, started } = await start();
    await pairing.approve(started.id, started.userCode, true, origin);
    advance(5000);
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => pairing.token(poll, origin)));
    const successes = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(successes.length, 1);
    assert.equal((await store.agents()).length, 1);
    const issued = successes[0].value.config.token;
    await assert.rejects(pairing.token(poll, origin), error => error.status === 409 && error.code === 'pairing_consumed');
    assert.ok(!JSON.stringify(await pairing.request(started.id, origin)).includes(issued));
    assert.equal((await store.authenticate(issued, origin)).id, successes[0].value.agent.id);
});

test('a transaction insertion failure rolls back consumption and HTTP returns no database detail', async () => {
    const { pairing, store, start, http, advance } = await fixture();
    const { poll, started } = await start('Reject fixture');
    await pairing.approve(started.id, started.userCode, true, origin);
    await store.q("CREATE TRIGGER fixture_reject_agent BEFORE INSERT ON probe_agents BEGIN SELECT RAISE(ABORT,'sensitive SQL fixture'); END").run();
    advance(5000);
    const rejected = await http('device-pairing/token', poll, {});
    assert.equal(rejected.status, 503);
    assert.deepEqual(rejected.error, { code: 'probe_unavailable' });
    const state = await pairing.request(started.id, origin);
    assert.equal(state.status, 'approved');
    assert.equal(state.agentId, null);
    assert.equal((await store.agents()).length, 0);
    await store.q('DROP TRIGGER fixture_reject_agent').run();
    advance(5000);
    assert.equal((await pairing.token(poll, origin)).status, 'consumed');
});

test('cancel fences approval and redemption; cancelling an already consumed window preserves the identity for explicit revocation', async () => {
    const { pairing, store, start, advance } = await fixture();
    const first = await start();
    await pairing.approve(first.started.id, first.started.userCode, true, origin);
    advance(5000);
    const race = await Promise.allSettled([pairing.token(first.poll, origin), pairing.cancelWindow(first.window.id, origin)]);
    const request = await pairing.request(first.started.id, origin);
    if (race[0].status === 'fulfilled') {
        assert.equal(request.status, 'consumed');
        assert.ok(await store.authenticate(race[0].value.config.token, origin));
    } else {
        assert.equal(request.status, 'cancelled');
        assert.equal(request.agentId, null);
    }
    const second = await start('Second');
    await pairing.approve(second.started.id, second.started.userCode, true, origin);
    advance(5000);
    const token = (await pairing.token(second.poll, origin)).config.token;
    await pairing.cancelWindow(second.window.id, origin);
    const consumed = await pairing.request(second.started.id, origin);
    assert.equal(consumed.status, 'consumed');
    await store.revokeAgent(consumed.agentId);
    await assert.rejects(store.authenticate(token, origin), /unauthorized/);
    await assert.rejects(pairing.token(second.poll, origin), /pairing_consumed/);
    const third = await start('Cancelled');
    await pairing.cancelWindow(third.window.id, origin);
    await assert.rejects(pairing.token(third.poll, origin), error => error.status === 410 && error.code === 'pairing_cancelled');
    await assert.rejects(pairing.approve(third.started.id, third.started.userCode, true, origin), /pairing_unavailable/);
});

test('expiry is exact and neither approval nor start extends the installation window', async () => {
    const { pairing, store, start, advance } = await fixture();
    const { window, poll, started, input } = await start();
    await pairing.approve(started.id, started.userCode, true, origin);
    advance(300000);
    assert.equal((await pairing.window(window.id, origin)).status, 'expired');
    await assert.rejects(pairing.token(poll, origin), error => error.status === 410 && error.code === 'pairing_expired');
    await assert.rejects(pairing.approve(started.id, started.userCode, true, origin), /pairing_unavailable/);
    await assert.rejects(pairing.start(input, origin), /pairing_unavailable/);
    assert.equal((await store.agents()).length, 0);
});

test('manual and pairing creation share an atomic 32-active-identity limit; old tokens remain compatible', async () => {
    const { pairing, store, start, advance } = await fixture();
    const { poll, started } = await start();
    await pairing.approve(started.id, started.userCode, true, origin);
    for (let i = 0; i < 31; i++) await store.addAgent(`Existing ${i}`);
    advance(5000);
    const results = await Promise.allSettled([pairing.token(poll, origin), ...Array.from({ length: 8 }, (_, i) => store.addAgent(`Concurrent ${i}`))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await store.agents()).filter(agent => !agent.revokedAt).length, 32);
    const released = (await store.agents())[0];
    await store.revokeAgent(released.id);
    const legacy = await store.addAgent('Legacy');
    assert.equal((await store.authenticate(legacy.token)).id, legacy.id);
    assert.equal((await store.authenticate(legacy.token, otherOrigin)).id, legacy.id);
});

test('window and request creation quotas persist across store instances and cannot grow through random limiter keys', async () => {
    const { pairing, db, store, start, advance, now } = await fixture();
    const window = await pairing.createWindow(origin);
    const base = { windowId: window.id, name: 'A', version: '1', platform: 'linux-amd64', proofHash: await digest(randomToken()) };
    const starts = await Promise.allSettled(Array.from({ length: 12 }, () => pairing.start(base, origin)));
    assert.equal(starts.filter(result => result.status === 'fulfilled').length, 3);
    assert.equal((await pairing.window(window.id, origin)).requests.length, 3);
    await pairing.cancelWindow(window.id, origin);
    for (let i = 1; i < 12; i++) {
        const next = await new ProbePairingStore(db, now).createWindow(origin);
        await pairing.cancelWindow(next.id, origin);
    }
    await assert.rejects(new ProbePairingStore(db, now).createWindow(origin), error => error.status === 429);
    advance(3600000);
    assert.ok((await start()).started.id);
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_pairing_budget').first()).n, 4);
});

test('invalid-window starts consume persistent global budget and invalid-secret polls consume window budget', async () => {
    const { pairing, store, db, start, now } = await fixture();
    const { input, window, poll } = await start();
    await store.q("UPDATE probe_pairing_budget SET count=119 WHERE key='start'").run();
    await assert.rejects(pairing.start({ ...input, windowId: missingId }, origin), /pairing_unavailable/);
    await assert.rejects(new ProbePairingStore(db, now).start(input, origin), error => error.status === 429);
    await store.q('UPDATE probe_pairing_windows SET token_attempts=299 WHERE id=?', window.id).run();
    await assert.rejects(pairing.token({ ...poll, proof: '0'.repeat(64) }, origin), error => error.status === 404);
    await assert.rejects(new ProbePairingStore(db, now).token(poll, origin), error => error.status === 429);
    assert.equal((await store.q('SELECT token_attempts FROM probe_pairing_windows WHERE id=?', window.id).first()).token_attempts, 300);
});

test('code attempts and poll timing have persistent budgets with bounded retry information', async () => {
    const { pairing, store, db, start, now, http, advance } = await fixture();
    const { poll, window, started } = await start();
    const early = await http('device-pairing/token', poll, {});
    assert.equal(early.status, 429);
    assert.deepEqual(early.error, { code: 'pairing_slow_down', retryAfterSeconds: 10 });
    assert.equal(early.headers.get('Retry-After'), '10');
    advance(10000);
    assert.equal((await new ProbePairingStore(db, now).token(poll, origin)).intervalSeconds, 10);
    await store.q('UPDATE probe_pairing_windows SET resolve_attempts=9 WHERE id=?', window.id).run();
    await assert.rejects(pairing.resolve(window.id, '00000-00000', origin), /pairing_unavailable/);
    await assert.rejects(pairing.approve(started.id, started.userCode, true, origin), error => error.status === 429);
    const newWindow = await pairing.createWindow(origin);
    await store.q("UPDATE probe_pairing_budget SET count=60 WHERE key='resolve'").run();
    await assert.rejects(pairing.resolve(newWindow.id, '00000-00000', origin), error => error.status === 429);
});

test('approval code is bound to a single immutable request and cleanup removes at most 100 old windows', async () => {
    const { pairing, store, start, advance, now } = await fixture();
    const a = await start('Original'); const b = await start('Other', a.window);
    await assert.rejects(pairing.approve(a.started.id, b.started.userCode, true, origin), /pairing_unavailable/);
    await pairing.approve(a.started.id, a.started.userCode, true, origin);
    assert.equal((await pairing.request(a.started.id, origin)).name, 'Original');
    advance(86400000 + 300001);
    for (let i = 0; i < 109; i++) await store.q('INSERT INTO probe_pairing_windows(id,origin,created_at,expires_at) VALUES (?,?,?,?)', crypto.randomUUID(), origin, now() - 90000000, now() - 86400001).run();
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_pairing_windows').first()).n, 110);
    await pairing.createWindow(origin);
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_pairing_windows').first()).n, 11);
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_pairings').first()).n, 0);
});

test('simultaneous windows and final poll/global budgets remain bounded across independent callers', async () => {
    const { pairing, store, start, http, advance } = await fixture();
    const first = await start();
    for (let i = 0; i < 3; i++) await pairing.createWindow(origin);
    await assert.rejects(pairing.createWindow(origin), error => error.status === 429);
    advance(5000);
    await store.q('UPDATE probe_pairings SET poll_count=100 WHERE id=?', first.started.id).run();
    assert.equal((await http('device-pairing/token', first.poll, {})).error.code, 'pairing_rate_limited');
    await store.q("UPDATE probe_pairing_budget SET count=2400 WHERE key='token'").run();
    const wrongSecret = await http('device-pairing/token', { ...first.poll, id: missingId }, {});
    assert.equal(wrongSecret.status, 429);
    assert.equal(wrongSecret.error.code, 'pairing_rate_limited');
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_agents').first()).n, 0);
});
