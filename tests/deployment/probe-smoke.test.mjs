import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDeployment,checkAcceptance} from '../../scripts/smoke-node-probes.mjs';
const sha='b'.repeat(40);
const project={subdomain:'misub-suffix.pages.dev',canonical_deployment:{url:'https://deadbeef.misub-suffix.pages.dev',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:sha}}}};
test('production smoke verifies actual domain, commit and status before logging in',()=>{
 assert.equal(verifyDeployment(project,sha).origin,'https://misub-suffix.pages.dev');
 assert.throws(()=>verifyDeployment(project,'a'.repeat(40)),/production_commit_not_ready/);
 assert.throws(()=>verifyDeployment({...project,subdomain:'attacker.example'},sha),/invalid_production_subdomain/);
 assert.throws(()=>verifyDeployment({...project,canonical_deployment:{...project.canonical_deployment,url:'https://evil.example'}},sha),/invalid_deployment_url/);
});
test('acceptance requires two distinct detectors and all five truthful results',()=>{
 const make=(id)=>({agent_id:id,state:'done',checks:Object.fromEntries(['format','tcp','proxy','speed','unlock'].map(type=>[type,type==='format'?{status:'passed',code:'ok'}:{status:'blocked',code:'unsafe_target'}]))});
 const data={nodes:[make('a'),make('b')],nextOffset:null};
 checkAcceptance(data,['a','b']);
 assert.throws(()=>checkAcceptance({...data,nodes:[make('a'),make('a')]},['a','b']),/detector_matrix_mismatch/);
 data.nodes[0].checks.tcp={status:'passed',code:'ok'};
 assert.throws(()=>checkAcceptance(data,['a','b']),/reserved_address_not_blocked/);
});
