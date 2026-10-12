import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { createProbeNodePreparer } from '../../functions/services/probe-node.js';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { database } from './sqlite-helper.mjs';
const base='https://misub.example/api/probes/v1/';
function fixture() {
    const env={MISUB_PROBE_DB:database()};
    const handle=createProbeHandler({authorizeAdmin:async r=>r.headers.get('x-test-admin')==='yes', prepareNodes:createProbeNodePreparer(()=>({type:'trojan',server:'example.com',port:443,password:'private-test-value'})),loadManualNodes:async()=>[{id:'n1',name:'one',url:'trojan://fixture@example.com:443'}]});
    const request=(path,body,headers={})=>new Request(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {env,handle,request};
}
const admin={'x-test-admin':'yes',Origin:'https://misub.example'};
test('installation capabilities are authenticated and fail closed for the current unpublished packages',async()=>{
    const {handle,request}=fixture();
    assert.equal((await handle(request('capabilities'),{})).status,401);
    const response=await handle(request('capabilities',undefined,admin),{});
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    const {data}=await response.json();
    assert.equal(data.storageReady,false);assert.equal(data.installation.distributionReady,false);
    assert.equal(data.installation.release,null);assert.equal(data.installation.targets.length,5);
    assert.ok(data.installation.targets.every(target=>target.available===false));
    assert.deepEqual(data.installation.legacyReleases,[{version:'0.1.0',tag:'probe-v0.1.0',capabilities:[]}]);
});
test('admin auth and CSRF are enforced before mutations',async()=>{
    const {env,handle,request}=fixture();
    assert.equal((await handle(request('agents'),env)).status,401);
    assert.equal((await handle(request('agents',{name:'probe'},{'x-test-admin':'yes'}),env)).status,403);
    assert.equal((await handle(request('agents',{name:'probe'},{...admin,Origin:'https://evil.example'}),env)).status,403);
    assert.equal((await handle(request('agents',{name:'probe'},admin),env)).status,201);
});
test('format checks work without D1 and do not return proxy credentials',async()=>{
    const {handle,request}=fixture();
    const r=await handle(request('format',{scope:'all'},admin),{});
    assert.equal(r.status,200); assert.equal(r.headers.get('Cache-Control'),'no-store');
    const text=await r.text(); assert.ok(!text.includes('private-test-value'));
    assert.equal(JSON.parse(text).data.nodes[0].checks.format.status,'passed');
});
test('agent token cannot use administrator endpoints or cross-origin cookie requests',async()=>{
    const {env,handle,request}=fixture();
    const store=await new ProbeStore(env.MISUB_PROBE_DB).init(); const a=await store.addAgent('agent');
    const headers={Authorization:`Bearer ${a.token}`};
    assert.equal((await handle(request('agents',undefined,headers),env)).status,401);
    assert.equal((await handle(request('agent/claim',{},headers),env)).status,200);
    assert.equal((await handle(request('agent/claim',{}, {...headers,Cookie:'session=fixture'}),env)).status,403);
    assert.equal((await handle(request('agent/claim',{}, {...headers,Origin:'https://misub.example'}),env)).status,403);
});
test('oversized bodies, missing nodes and undeclared types fail closed',async()=>{
    const {env,handle,request}=fixture();
    assert.equal((await handle(request('format',{scope:'selected',nodeIds:['missing']},admin),env)).status,404);
    assert.equal((await handle(request('format',{scope:'all'}, {...admin,'Content-Length':'1048577'}),env)).status,413);
    assert.equal((await handle(request('jobs',{scope:'all',agentIds:['x'],types:['untrusted']},admin),env)).status,400);
});
test('plain parser success is not reported as connectivity and invalid proxies are rejected',async()=>{
    const prepare=createProbeNodePreparer(()=>({type:'trojan',server:'example.com',port:443}));
    const n=(await prepare([{id:'x',url:'trojan://invalid'}]))[0];
    assert.equal(n.format.status,'failed'); assert.equal(n.proxy,null); assert.equal(n.healthy,undefined);
});
test('task creation requires explicit node-sharing consent',async()=>{
 const {env,handle,request}=fixture();
 const store=await new ProbeStore(env.MISUB_PROBE_DB).init();const a=await store.addAgent('agent');
 const body={scope:'all',agentIds:[a.id],types:['tcp']};
 const denied=await handle(request('jobs',body,{...admin,'Idempotency-Key':'consent-test-01'}),env);
 assert.equal(denied.status,400);assert.equal((await denied.json()).error.code,'consent_required');
 const accepted=await handle(request('jobs',{...body,consent:true},{...admin,'Idempotency-Key':'consent-test-01'}),env);
 assert.equal(accepted.status,202);
});
