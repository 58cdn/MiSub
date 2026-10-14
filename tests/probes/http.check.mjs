import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProbeHandler } from '../../functions/services/probe-http.js';
import { createProbeNodePreparer } from '../../functions/services/probe-node.js';
import { ProbeStore } from '../../functions/services/probe-store.js';
import { database } from './sqlite-helper.mjs';
import releaseCatalog from '../../detector/release-catalog.json' with { type: 'json' };
import { validateProbeReleaseCatalog, readProbeInstallation, PROBE_RELEASE_TARGETS } from '../../src/shared/probe-release.js';
const base='https://misub.example/api/probes/v1/';
function fixture() {
    const env={MISUB_PROBE_DB:database()};
    const handle=createProbeHandler({authorizeAdmin:async r=>r.headers.get('x-test-admin')==='yes', prepareNodes:createProbeNodePreparer(()=>({type:'trojan',server:'example.com',port:443,password:'private-test-value'})),loadManualNodes:async()=>[{id:'n1',name:'one',url:'trojan://fixture@example.com:443'}]});
    const request=(path,body,headers={})=>new Request(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {env,handle,request};
}
const admin={'x-test-admin':'yes',Origin:'https://misub.example'};
test('installation capabilities authenticate reads and expose the validated production catalog without D1',async()=>{
    const {handle,request}=fixture();
    assert.equal((await handle(request('capabilities'),{})).status,401);
    const response=await handle(request('capabilities',undefined,admin),{});
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    const {data}=await response.json();
    const verified=validateProbeReleaseCatalog(releaseCatalog);
    assert.equal(data.storageReady,false);
    assert.deepEqual(readProbeInstallation(data.installation),data.installation);
    assert.equal(data.installation.distributionReady,verified.distributionReady);
    assert.deepEqual(data.installation.release,verified.release);
    assert.deepEqual(data.installation.legacyReleases,verified.legacyReleases);
    assert.deepEqual(data.installation.targets.map(({target})=>target),PROBE_RELEASE_TARGETS);
    for(const {target,available} of data.installation.targets) {
        assert.equal(available,verified.distributionReady&&verified.release.assets.some(asset=>asset.target===target));
    }
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

const runtimeSchema = readFileSync(new URL('../../migrations/probes/0001_agent_runtime.sql', import.meta.url), 'utf8');
const declared = { schemaVersion: 1, observationsVersion: 1 };

test('runtime HTTP modes preserve legacy reads and expose only bounded administrator declarations', async () => {
    const { env, handle, request } = fixture();
    const store = await new ProbeStore(env.MISUB_PROBE_DB).init();
    const agent = await store.addAgent('runtime fixture');
    const headers = { Authorization: `Bearer ${agent.token}` };
    assert.equal((await handle(request('agent/claim', { capabilities: declared }, headers), env)).status, 200);
    assert.equal(await store.q("SELECT name FROM sqlite_master WHERE name='probe_agent_runtime_v1'").first(), null);
    await env.MISUB_PROBE_DB.prepare(runtimeSchema).run();
    env.PROBE_AGENT_RUNTIME_MODE = 'record';
    assert.equal((await handle(request('agent/claim', { observationsVersion: 1, capabilities: { ...declared, token: 'fixture-private-claim' } }, headers), env)).status, 200);
    const overview = async () => (await (await handle(request('agents/overview', undefined, admin), env)).json()).data;
    assert.equal((await overview()).agents[0].capabilities, null);
    env.PROBE_AGENT_RUNTIME_MODE = 'read';
    const result = await overview();
    assert.equal(result.agents[0].capabilities.state, 'declared');
    assert.equal(result.agents[0].capabilities.source, 'agent_claim');
    assert.equal(result.agents[0].capabilities.observationsVersion, 1);
    assert.ok(!JSON.stringify(result).includes('fixture-private-claim'));
    const history = await (await handle(request(`agents/${agent.id}/history`, undefined, admin), env)).json();
    assert.equal(history.data.agent.capabilities.state, 'declared');
    assert.equal((await handle(request('agents/overview', undefined, headers), env)).status, 401);
    env.PROBE_AGENT_RUNTIME_MODE = 'off';
    assert.equal((await overview()).agents[0].capabilities, null);
});

test('runtime missing schema fails closed with fixed HTTP errors without blocking revoke or cancellation', async () => {
    const { env, handle, request } = fixture();
    const store = await new ProbeStore(env.MISUB_PROBE_DB).init();
    const agent = await store.addAgent('runtime unavailable');
    const jobResponse = await handle(request('jobs', { scope: 'all', agentIds: [agent.id], types: ['tcp'], consent: true }, { ...admin, 'Idempotency-Key': 'runtime-http-job' }), env);
    const { data: job } = await jobResponse.json();
    env.PROBE_AGENT_RUNTIME_MODE = 'record';
    const claim = await handle(request('agent/claim', { capabilities: declared }, { Authorization: `Bearer ${agent.token}` }), env);
    assert.equal(claim.status, 503);
    assert.deepEqual(await claim.json(), { success: false, error: { code: 'probe_runtime_unavailable' } });
    const task = await store.q('SELECT state,attempt FROM probe_tasks WHERE job_id=?', job.id).first();
    assert.equal(task.state, 'queued');
    assert.equal(task.attempt, 0);
    env.PROBE_AGENT_RUNTIME_MODE = 'read';
    const overview = await handle(request('agents/overview', undefined, admin), env);
    assert.equal(overview.status, 503);
    assert.equal((await overview.json()).error.code, 'probe_runtime_unavailable');
    assert.equal(await store.q("SELECT name FROM sqlite_master WHERE name='probe_agent_runtime_v1'").first(), null);
    env.PROBE_AGENT_RUNTIME_MODE = 'invalid-fixture-mode';
    const invalid = await handle(request('agent/claim', {}, { Authorization: `Bearer ${agent.token}` }), env);
    assert.equal(invalid.status, 503);
    assert.equal((await invalid.json()).error.code, 'probe_runtime_mode_invalid');
    assert.equal((await handle(request(`jobs/${job.id}/cancel`, {}, admin), env)).status, 200);
    assert.equal((await handle(new Request(`${base}agents/${agent.id}`, { method: 'DELETE', headers: admin }), env)).status, 200);
    assert.equal((await store.q('SELECT state FROM probe_tasks WHERE job_id=?', job.id).first()).state, 'cancelled');
});

test('runtime declaration writes remain behind native agent authentication and strip unknown fields', async () => {
    const { env, handle, request } = fixture();
    const store = await new ProbeStore(env.MISUB_PROBE_DB).init();
    const agent = await store.addAgent('runtime authentication');
    await env.MISUB_PROBE_DB.prepare(runtimeSchema).run();
    env.PROBE_AGENT_RUNTIME_MODE = 'read';
    const body = { observationsVersion: 1, capabilities: { schemaVersion: 2, observationsVersion: 1, password: 'fixture-private-declaration' } };
    for (const headers of [admin, { Authorization: `Bearer mp1_${'0'.repeat(64)}` }, { Authorization: `Bearer ${agent.token}`, Cookie: 'fixture' }, { Authorization: `Bearer ${agent.token}`, Origin: 'https://misub.example' }]) {
        assert.ok([401, 403].includes((await handle(request('agent/claim', body, headers), env)).status));
    }
    assert.equal((await store.q('SELECT COUNT(*) AS n FROM probe_agent_runtime_v1').first()).n, 0);
    assert.equal((await handle(request('agent/claim', body, { Authorization: `Bearer ${agent.token}` }), env)).status, 200);
    const response = await handle(request('agents/overview', undefined, admin), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    assert.ok(!text.includes('fixture-private-declaration'));
    assert.equal(JSON.parse(text).data.agents[0].capabilities.state, 'unsupported_schema');
    assert.equal(JSON.parse(text).data.agents[0].capabilities.observationsVersion, null);
});
