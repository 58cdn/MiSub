import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './sqlite-helper.mjs';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { normalizeOptions } from '../../functions/services/probe-contract.js';
async function setup() {
    let now=1000000;
    const s=await new ProbeStore(database(), () => now).init();
    const a=await s.addAgent('Singapore');
    const b=await s.addAgent('Mac');
    const nodes=[{id:'n1',name:'one',proxy:{type:'trojan',server:'example.com',port:443,password:'private-value'},format:{status:'passed',code:'ok'}}];
    const input={nodes,agentIds:[a.id,b.id],...normalizeOptions({types:['tcp']},1,2)};
    return {s,a,b,input,advance: ms => { now+=ms; }};
}
test('transactional enqueue and independent per-detector leases', async () => {
    const {s,a,b,input}=await setup();
    const job=await s.createJob(input,'test-key-01');
    assert.equal((await s.createJob(input,'test-key-01')).id,job.id);
    const first=await s.claim(a);
    assert.equal(await s.claim(a),null);
    const second=await s.claim(b);
    assert.notEqual(first.id,second.id);
    assert.equal(first.jobId,second.jobId);
    const results=await s.results(job.id);
    assert.equal(results.nodes.length,2);
    assert.ok(!JSON.stringify(results).includes('private-value'));
});
test('results are authenticated, idempotent, and strip payload credentials', async () => {
    const {s,a,b,input}=await setup();
    await s.createJob(input,'test-key-02');
    const t=await s.claim(a);
    const result={tcp:{status:'passed',code:'ok',latencyMs:12}};
    await assert.rejects(s.finish(b,t.id,t.leaseToken,result),/task_not_found/);
    await assert.rejects(s.finish(a,t.id,'f'.repeat(64),result),/lease_lost/);
    assert.equal((await s.finish(a,t.id,t.leaseToken,result)).replay,false);
    assert.equal((await s.finish(a,t.id,t.leaseToken,result)).replay,true);
    assert.equal((await s.q('SELECT node_payload FROM probe_tasks WHERE id=?',t.id).first()).node_payload,null);
});
test('expired leases cannot renew or submit; next attempt fences old lease', async () => {
    const {s,a,input,advance}=await setup();
    await s.createJob(input,'test-key-03');
    const old=await s.claim(a); advance(90001);
    await assert.rejects(s.heartbeat(a,old.id,old.leaseToken),/lease_lost/);
    const next=await s.claim(a);
    assert.equal(next.id,old.id); assert.equal(next.attempt,2);
    await assert.rejects(s.finish(a,old.id,old.leaseToken,{tcp:{status:'passed',code:'ok'}}),/lease_lost/);
    await s.heartbeat(a,next.id,next.leaseToken);
});
test('cancel and revoke fence in-flight work; task credentials are wiped', async () => {
    const {s,a,b,input}=await setup();
    const job=await s.createJob(input,'test-key-04'); const t=await s.claim(a);
    await s.cancel(job.id);
    await assert.rejects(s.heartbeat(a,t.id,t.leaseToken),/lease_lost/);
    assert.equal(await s.claim(b),null);
    await s.revokeAgent(a.id);
    await assert.rejects(s.authenticate(a.token),/unauthorized/);
    await assert.rejects(s.createJob(input,'test-key-05'),/agent_unavailable/);
});
test('attempts and retention are bounded, idempotency mismatch rejected', async () => {
    const {s,a,input,advance}=await setup();
    const job=await s.createJob(input,'test-key-06');
    await assert.rejects(s.createJob({...input,types:['proxy']},'test-key-06'),/idempotency_conflict/);
    for(let i=0;i<3;i++){ assert.ok(await s.claim(a)); advance(90001); }
    assert.equal(await s.claim(a),null);
    assert.equal((await s.results(job.id)).nodes.find(x=>x.agent_id===a.id).state,'expired');
    advance(8*86400000); await s.sweep();
    await assert.rejects(s.results(job.id),/job_not_found/);
});

test('concurrent claims for the same detector admit only one lease', async () => {
    const {s,a,input}=await setup();
    await s.createJob(input,'test-key-07');
    const rows=await Promise.all([s.claim(a),s.claim(a)]);
    assert.equal(rows.filter(Boolean).length,1);
});
