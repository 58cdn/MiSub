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

test('preserves bounded rate-limit evidence without raw response headers', () => {
    const v = {status:'unknown',code:'rate_limited',httpStatus:429,retryAfterSeconds:120,headers:{secret:'discard'}};
    assert.deepEqual(sanitizeResult({proxy:v}, ['proxy']), {proxy:{status:'unknown',code:'rate_limited',httpStatus:429,retryAfterSeconds:120}});
    assert.equal(sanitizeResult({unlock:{status:'unknown',code:'probe_inconclusive',services:[{service:'netflix',...v}]}}, ['unlock'], ['netflix']).unlock.services[0].retryAfterSeconds,120);
    for (const retryAfterSeconds of [-1, 86401, 0.5, '120', NaN, Infinity]) assert.throws(() => sanitizeResult({proxy:{...v,retryAfterSeconds}}, ['proxy']), /invalid_retry_after/);
    assert.throws(() => sanitizeResult({proxy:{...v,code:'ok'}}, ['proxy']), /invalid_rate_limit/);
    assert.throws(() => sanitizeResult({proxy:{...v,httpStatus:200}}, ['proxy']), /invalid_rate_limit/);
    for (const patch of [{status:'passed'}, {bytes:1024}, {latencyMs:1}, {bytesPerSecond:1}, {region:'US'}]) {
        const invalid = {...v, ...patch};
        delete invalid.retryAfterSeconds;
        assert.throws(() => sanitizeResult({proxy:invalid}, ['proxy']), /invalid_rate_limit/);
        assert.throws(() => sanitizeResult({unlock:{status:'unknown',code:'probe_inconclusive',services:[{service:'netflix',...invalid}]}}, ['unlock'], ['netflix']), /invalid_rate_limit/);
    }
});
