import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeOptions,sanitizeResult} from '../../functions/services/probe-contract.js';
import {SOURCES,emptyResult} from '../../functions/services/diagnostics/contract.js';
import {ProbeStore} from '../../functions/services/probe-store.js';
import {database} from './sqlite-helper.mjs';
const timestamp=Date.parse('2026-01-01T00:00:00Z');
const context={taskId:'fixture-task',startedAt:timestamp-1000,now:timestamp};
const sources=['ipify','ip_sb','ifconfig','ippure'];
const options={observationsVersion:1,sources};
function report(id='fixture-task') {
    const results=sources.map(source=>({...emptyResult(SOURCES.find(s=>s.id===source),'ok',null),checkedAt:new Date(timestamp).toISOString(),httpStatus:200,ip:'198.51.100.1',family:4}));
    results[1].countryCode='US'; results[2].ip='198.51.100.2';
    Object.assign(results[3],{countryCode:'JP',status:'partial',riskScore:7.5,isResidential:false});
    return {version:1,requestId:id,scope:'node',results,conflicts:[],secret:'discard'};
}
const checks=report=>({observations:{status:'unknown',code:'probe_inconclusive',report}});
const clean=r=>sanitizeResult(checks(r),['observations'],[],options,context).observations.report;

test('Go parser and control plane share the same versioned JSON wire fixture',()=>{
    const fixture=JSON.parse(readFileSync(new URL('../../detector/testdata/observations-v1.json',import.meta.url),'utf8'));
    const out=clean(fixture.report);
    assert.equal(out.results.length,4);
    assert.equal(out.conflicts.length,2);
    assert.equal(out.results[3].riskScore,7.5);
    assert.equal(out.results[3].isBroadcast,null);
});

test('observations are opt-in, bounded and explicitly versioned',()=>{
    assert.equal(normalizeOptions({types:['tcp']},1,1).options.observationsVersion,undefined);
    const value=normalizeOptions({types:['observations']},1,1);
    assert.equal(value.options.observationsVersion,1);
    assert.deepEqual(value.options.sources,['ipify','ip_sb','ifconfig','icanhazip']);
    for(const values of [[],['ping0'],['ipify','ipify'],['latency'],['https://evil.invalid']]) assert.throws(()=>normalizeOptions({types:['observations'],options:{sources:values}},1,1),/invalid_sources/);
    assert.throws(()=>normalizeOptions({types:['observations'],options:{observationsVersion:2}},1,1),/invalid_observations_version/);
});
test('retains source evidence/unknowns and recomputes IP and country conflicts',()=>{
    const out=clean(report());
    assert.deepEqual(out.conflicts,[{type:'ip',family:4,values:['198.51.100.1','198.51.100.2']},{type:'country',ip:'198.51.100.1',values:['US','JP']}]);
    assert.equal(out.results[3].isResidential,false); assert.equal(out.results[3].isBroadcast,null);
    assert.equal(out.results[3].riskScore,7.5); assert.equal(out.results[0].countryCode,null);
    assert.equal(out.secret,undefined); assert.equal(out.results[0].latencyMs,null);
});
test('rejects missing/duplicate sources, false success, forged fields and stale/future data',()=>{
    for(const mutate of [
        r=>r.results.pop(), r=>r.results[1]=r.results[0], r=>r.version=2,
        r=>r.scope='server', r=>r.requestId='wrong-task',
        r=>r.results[0].riskScore=10, r=>r.results[0].latencyMs=1,
        r=>r.results[0].httpStatus=429, r=>r.results[0].retryAfterSeconds=120,
        r=>r.results[0].checkedAt=new Date(timestamp+60000).toISOString(),
        r=>r.results[0].checkedAt=new Date(timestamp-86400000).toISOString(),
    ]) { const r=report(); mutate(r); assert.throws(()=>clean(r),/invalid_observations/); }
    const input=checks(report()); input.observations.status='passed';
    assert.throws(()=>sanitizeResult(input,['observations'],[],options,context),/invalid_observations_status/);
    for(const fields of [{code:'native_unlocked'},{latencyMs:123},{region:'US'},{bytes:123},{httpStatus:200}]) {
        const forged=checks(report()); Object.assign(forged.observations,fields);
        assert.throws(()=>sanitizeResult(forged,['observations'],[],options,context),/invalid_observations_status/);
    }
});
test('IPv4 and IPv6 do not create a false same-family conflict',()=>{
    const r=report(); r.results[2].ip='2001:db8::1';r.results[2].family=6;
    assert.equal(clean(r).conflicts.filter(c=>c.type==='ip').length,0);
});
test('old detectors skip observation leases; result replay is stable and strips credentials',async()=>{
    let now=timestamp;
    const store=await new ProbeStore(database(),()=>now).init(); const agent=await store.addAgent('fixture');
    const job=await store.createJob({nodes:[{id:'n1',name:'fixture',format:{status:'passed',code:'ok'},proxy:{password:'fixture-private'}}],agentIds:[agent.id],...normalizeOptions({types:['observations'],options:{sources}},1,1)},'observations-key');
    assert.equal(await store.claim(agent),null);
    assert.equal(await store.claim(agent,{observationsVersion:2}),null);
    const task=await store.claim(agent,{observationsVersion:1}); assert.ok(task);
    assert.equal(task.options.observationsVersion,1);
    const input=checks(report(task.id)); input.observations.report.results[0].password='must-discard';
    assert.equal((await store.finish(agent,task.id,task.leaseToken,input)).replay,false);
    now+=60000;
    assert.equal((await store.finish(agent,task.id,task.leaseToken,input)).replay,true);
    const output=await store.results(job.id);
    assert.ok(!JSON.stringify(output).includes('must-discard'));
    assert.ok(!JSON.stringify(output).includes('fixture-private'));
    assert.equal(Date.parse(output.nodes[0].checks.observations.report.checkedAt),timestamp);
});

test('queued job time and delayed delivery do not refresh old source evidence',async()=>{
    let now=timestamp;
    const store=await new ProbeStore(database(),()=>now).init(); const agent=await store.addAgent('fixture');
    const job=await store.createJob({nodes:[{id:'n1',name:'fixture',format:{status:'passed',code:'ok'},proxy:{}}],agentIds:[agent.id],...normalizeOptions({types:['observations'],options:{sources}},1,1)},'observations-age');
    now+=3600000;
    const task=await store.claim(agent,{observationsVersion:1});
    await assert.rejects(store.finish(agent,task.id,task.leaseToken,checks(report(task.id))),/invalid_observations/);
    const fresh=report(task.id);fresh.results.forEach(r=>{r.checkedAt=new Date(now-60000).toISOString();});
    await store.finish(agent,task.id,task.leaseToken,checks(fresh));
    const accepted=(await store.results(job.id)).nodes[0].checks.observations.report;
    assert.equal(Date.parse(accepted.checkedAt),now-60000);
    assert.equal(Date.parse(accepted.expiresAt),now-60000+600000);
    now+=120000;
    assert.equal((await store.finish(agent,task.id,task.leaseToken,checks(fresh))).replay,true);
});
