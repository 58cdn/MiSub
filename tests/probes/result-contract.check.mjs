import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeResult, normalizeOptions } from '../../functions/services/probe-contract.js';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { database } from './sqlite-helper.mjs';
import { readFile } from 'node:fs/promises';

const wrapService = (value) => ({
    status: 'unknown',
    code: 'probe_inconclusive',
    services: [{ service: 'netflix', ...value }],
});
const invalid = [
    ['proxy success with format failure', 'proxy', { status: 'passed', code: 'invalid_format' }],
    ['proxy failure with success code', 'proxy', { status: 'failed', code: 'ok' }],
    ['TCP fractional HTTP status', 'tcp', { status: 'passed', code: 'ok', httpStatus: 200.5 }],
    [
        'service success with format failure',
        'unlock',
        wrapService({ status: 'passed', code: 'invalid_format' }),
    ],
    ['TCP HTTP status', 'tcp', { status: 'passed', code: 'ok', httpStatus: 200 }],
    ['TCP download metric', 'tcp', { status: 'passed', code: 'ok', bytes: 1 }],
    ['format network measurement', 'format', { status: 'passed', code: 'ok', latencyMs: 1 }],
    [
        'proxy fractional HTTP status',
        'proxy',
        { status: 'failed', code: 'http_error', httpStatus: 200.5 },
    ],
    [
        'HTTP status below protocol range',
        'proxy',
        { status: 'failed', code: 'http_error', httpStatus: 99 },
    ],
    ['fractional downloaded bytes', 'speed', { status: 'passed', code: 'ok', bytes: 65536.5 }],
    ['unlock aggregate success', 'unlock', { status: 'passed', code: 'ok', services: [] }],
    [
        'unsupported unlock conclusion',
        'unlock',
        wrapService({ status: 'passed', code: 'native_unlocked' }),
    ],
    [
        'service latency misattributed as node latency',
        'unlock',
        wrapService({ status: 'unknown', code: 'service_reachable', latencyMs: 10 }),
    ],
    [
        'TCP prerequisite with measurement',
        'tcp',
        { status: 'skipped', code: 'prerequisite_failed', latencyMs: 1 },
    ],
    ['proxy success with HTTP failure', 'proxy', { status: 'passed', code: 'ok', httpStatus: 500 }],
    ['speed success with HTTP failure', 'speed', { status: 'passed', code: 'ok', httpStatus: 500 }],
    ['short download claimed as success', 'speed', { status: 'passed', code: 'ok', bytes: 10 }],
    [
        'service reachable with server error',
        'unlock',
        wrapService({ status: 'unknown', code: 'service_reachable', httpStatus: 500 }),
    ],
    [
        'Netflix reachable with OpenAI-only status',
        'unlock',
        wrapService({ status: 'unknown', code: 'service_reachable', httpStatus: 401 }),
    ],
    [
        'null service entry',
        'unlock',
        { status: 'unknown', code: 'probe_inconclusive', services: [null] },
    ],
];
for (const [name, type, value] of invalid) {
    test(`reject ${name} before completing the task`, async () => {
        assert.throws(() => sanitizeResult({ [type]: value }, [type], ['netflix']));
        const db = database();
        let now = 1000000;
        const store = await new ProbeStore(db, () => now).init();
        const agent = await store.addAgent('synthetic-detector');
        const types = [type];
        await store.createJob(
            {
                nodes: [
                    {
                        id: 'fixture',
                        name: 'fixture',
                        proxy: null,
                        format: { status: 'failed', code: 'invalid_format' },
                    },
                ],
                agentIds: [agent.id],
                ...normalizeOptions(
                    { types, options: { services: ['netflix'], allowMetered: true } },
                    1,
                    1
                ),
            },
            `invalid-${type}`
        );
        const task = await store.claim(agent);
        const handler = createProbeHandler({
            authorizeAdmin: async () => false,
            makeStore: () => store,
        });
        const submit = (checks, leaseToken = task.leaseToken) =>
            handler(
                new Request(`https://misub.example/api/probes/v1/agent/tasks/${task.id}/result`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${agent.token}`,
                    },
                    body: JSON.stringify({ leaseToken, checks }),
                }),
                { MISUB_PROBE_DB: db }
            );
        const row = () =>
            store
                .q(
                    'SELECT state,result_json,result_hash,completed_at,node_payload,lease_hash FROM probe_tasks WHERE id=?',
                    task.id
                )
                .first();
        const before = await row();
        const response = await submit({ [type]: value });
        assert.equal(response.status, 400);
        assert.deepEqual(await row(), before);
        const good = {
            [type]:
                type === 'format'
                    ? { status: 'passed', code: 'ok' }
                    : { status: 'skipped', code: 'prerequisite_failed' },
        };
        assert.equal((await submit(good, 'f'.repeat(64))).status, 409);
        assert.equal((await submit(good)).status, 200);
        const accepted = await row();
        assert.equal(accepted.state, 'done');
        assert.equal(accepted.node_payload, null);
        now += 1000;
        const replay = await submit(good);
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).data.replay, true);
        assert.deepEqual(await row(), accepted);
    });
}

test('preserves optional measurements and partial speed failures', () => {
    for (const [status, code] of [
        ['passed', 'ok'],
        ['failed', 'request_failed'],
        ['timeout', 'deadline'],
        ['cancelled', 'cancelled'],
        ['unknown', 'probe_inconclusive'],
    ]) {
        const bytes = status === 'passed' ? 65536 : 10;
        const speed = { status, code, bytes, bytesPerSecond: 1.5, latencyMs: 100, httpStatus: 200 };
        assert.deepEqual(sanitizeResult({ speed }, ['speed']), { speed });
    }
    assert.deepEqual(sanitizeResult({ tcp: { status: 'passed', code: 'ok' } }, ['tcp']), {
        tcp: { status: 'passed', code: 'ok' },
    });
    for (const type of ['proxy', 'speed', 'unlock']) {
        const check = { status: 'unsupported', code: 'cancelled' };
        assert.deepEqual(sanitizeResult({ [type]: check }, [type]), { [type]: check });
    }
});

test('preserves cancelled unlock containers and old provider timestamps', () => {
    const unlock = {
        status: 'cancelled',
        code: 'cancelled',
        services: [
            { service: 'netflix', status: 'unknown', code: 'service_reachable', httpStatus: 200 },
            { service: 'openai', status: 'cancelled', code: 'cancelled' },
        ],
    };
    assert.deepEqual(sanitizeResult({ unlock }, ['unlock'], ['netflix', 'openai']), { unlock });
    assert.equal(
        sanitizeResult({ unlock }, ['unlock'], ['netflix', 'openai']).unlock.services[0].checkedAt,
        undefined
    );
});

test('accepts the checks produced by the native detector fixture', async () => {
    const fixture = JSON.parse(
        await readFile(new URL('../fixtures/probe-check-results.json', import.meta.url), 'utf8')
    );
    assert.equal(fixture.version, 1);
    assert.ok(fixture.cases.length >= 40);
    const now = Date.parse('2026-01-01T00:00:00Z');
    for (const entry of fixture.cases) {
        const expected = structuredClone(entry.checks);
        for (const service of expected.unlock?.services ?? []) {
            if (service.checkedAt) service.checkedAt = new Date(service.checkedAt).toISOString();
        }
        assert.deepEqual(
            sanitizeResult(
                entry.checks,
                entry.types,
                entry.services ?? [],
                {},
                { now, startedAt: now - 1000 }
            ),
            expected,
            entry.name
        );
    }
});
