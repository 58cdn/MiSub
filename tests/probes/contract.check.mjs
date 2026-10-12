import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, sanitizeResult, publicAgent, digest, randomToken } from '../../functions/services/probe-contract.js';
test('five types and opt-in bounded downloads', () => {
    const n = normalizeOptions({types:['format','tcp','proxy','speed','unlock'], options:{allowMetered:true}}, 2, 2);
    assert.equal(n.types.length, 5);
    assert.equal(n.options.worstCaseDownloadBytes, 62914560);
    assert.throws(() => normalizeOptions({types:['speed']}, 1, 1), /speed_consent_required/);
    assert.throws(() => normalizeOptions({types:['speed'],options:{allowMetered:true}}, 500, 8), /job_traffic_limit/);
    assert.throws(() => normalizeOptions({types:['anything']}, 1, 1), /invalid_types/);
});
test('agent/result whitelist cannot expose credentials or error text', () => {
    assert.equal(publicAgent({id:'a',token_hash:'secret'}).token_hash, undefined);
    const r = sanitizeResult({tcp:{status:'failed',code:'connect_failed',message:'credential',url:'secret'}}, ['tcp']);
    assert.deepEqual(r, {tcp:{status:'failed',code:'connect_failed'}});
    assert.throws(() => sanitizeResult({tcp:{status:'passed',code:'secret'}}, ['tcp']), /invalid_result_code/);
    assert.throws(() => sanitizeResult({}, ['tcp']), /invalid_result_status/);
});
test('reject non-finite metrics and unexpected/duplicate services', () => {
    assert.throws(() => sanitizeResult({tcp:{status:'passed',code:'ok',latencyMs:NaN}}, ['tcp']));
    assert.throws(() => sanitizeResult({unlock:{status:'passed',code:'ok',services:[{service:'other',status:'passed',code:'ok'}]}}, ['unlock'], ['netflix']));
});
test('token hashes are stable and tokens have 256 random bits', async () => {
    const token = randomToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, randomToken());
    assert.equal(await digest(token), await digest(token));
    assert.notEqual(await digest(token), token);
});
