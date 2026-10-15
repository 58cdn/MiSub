import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDeployment,checkAcceptance,smoke} from '../../scripts/smoke-node-probes.mjs';
const sha='b'.repeat(40);
const identity={productVersion:'0.0.1-alpha.17',sourceCommit:sha,kernelVersion:'v1.19.32',platform:'linux-amd64',buildChannel:'development',sourceState:'clean'};
const metadata={schemaVersion:1,source:'detector_reported',wrapperVersion:identity.productVersion,wrapperRevision:sha,kernelLockVersion:identity.kernelVersion,platform:identity.platform,buildChannel:identity.buildChannel,sourceState:identity.sourceState};
const project={subdomain:'misub-suffix.pages.dev',canonical_deployment:{url:'https://deadbeef.misub-suffix.pages.dev',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:sha}}}};
test('production acceptance rejects automatic or unconfirmed execution before credentials or network access',async()=>{
 for(const event of ['push','pull_request','schedule']) await assert.rejects(smoke({RUN_NODE_PROBE_ACCEPTANCE:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:event,GITHUB_REF:'refs/heads/main'}),/manual_acceptance_required/);
 await assert.rejects(smoke({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'}),/manual_acceptance_required/);
 await assert.rejects(smoke({RUN_NODE_PROBE_ACCEPTANCE:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/feature'}),/manual_acceptance_required/);
 await assert.rejects(smoke({RUN_NODE_PROBE_ACCEPTANCE:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'}),/missing_smoke_environment/);
});
test('production smoke verifies actual domain, commit and status before logging in',()=>{
 assert.equal(verifyDeployment(project,sha).origin,'https://misub-suffix.pages.dev');
 assert.throws(()=>verifyDeployment(project,'a'.repeat(40)),/production_commit_not_ready/);
 assert.throws(()=>verifyDeployment({...project,subdomain:'attacker.example'},sha),/invalid_production_subdomain/);
 assert.throws(()=>verifyDeployment({...project,canonical_deployment:{...project.canonical_deployment,url:'https://evil.example'}},sha),/invalid_deployment_url/);
});
test('acceptance requires two distinct detectors and all five truthful results',()=>{
 const make=(id)=>({agent_id:id,state:'done',executionMetadata:{...metadata},checks:Object.fromEntries(['format','tcp','proxy','speed','unlock'].map(type=>[type,type==='format'?{status:'passed',code:'ok'}:{status:'blocked',code:'unsafe_target'}]))});
 const data={nodes:[make('a'),make('b')],nextOffset:null};
 checkAcceptance(data,['a','b'],identity);
 assert.throws(()=>checkAcceptance({...data,nodes:[make('a'),make('a')]},['a','b'],identity),/detector_matrix_mismatch/);
 for(const change of [{executionMetadata:null},{executionMetadata:{...metadata,wrapperVersion:'0.1.0'}},{executionMetadata:{...metadata,wrapperRevision:'a'.repeat(40)}}]) {
  assert.throws(()=>checkAcceptance({...data,nodes:[make('a'),{...make('b'),...change}]},['a','b'],identity),/acceptance_result_identity_mismatch/);
 }
 data.nodes[0].checks.tcp={status:'passed',code:'ok'};
 assert.throws(()=>checkAcceptance(data,['a','b'],identity),/reserved_address_not_blocked/);
});

test('source mismatch stops manual smoke before any network or identity request',async()=>{
 const original=globalThis.fetch;
 let requests=0;
 globalThis.fetch=()=>{ requests++; throw new Error('unexpected_network'); };
 try {
  await assert.rejects(smoke({RUN_NODE_PROBE_ACCEPTANCE:'true',GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'0'.repeat(40),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'fixture-only',ADMIN_PASSWORD:'fixture-only'}),/acceptance_source_mismatch/);
  assert.equal(requests,0);
 } finally { globalThis.fetch=original; }
});
