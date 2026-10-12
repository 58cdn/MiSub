import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectedProbeNodes, makeProbePlan } from '../../src/utils/probe-client.js';
const nodes=Array.from({length:1200},(_,i)=>({id:`n${i}`,name:`node ${i}`,url:'trojan://fixture@example.com:443',enabled:i%2===0}));
test('all nodes includes disabled nodes and crosses pagination; selection never widens',()=>{
 assert.equal(selectedProbeNodes(nodes,new Set(['n1']),'all').length,1200);
 assert.deepEqual(selectedProbeNodes(nodes,new Set(['n1','n999']),'selected').map(n=>n.id),['n1','n999']);
 assert.throws(()=>selectedProbeNodes(nodes,new Set(['missing']),'selected'),/selection_changed/);
});
test('snapshot batches retain every node and respect 500-node and wire size caps',()=>{
 const p=makeProbePlan(nodes,['format','tcp'],['agent'],{timeoutMs:5000,downloadBytes:5*1024**2});
 assert.equal(p.chunks.length,3); assert.equal(p.chunks.flatMap(x=>x.nodes).length,1200);
 for(const c of p.chunks){assert.ok(c.nodes.length<=500);assert.ok(new TextEncoder().encode(JSON.stringify(c)).length<=768*1024);}
});
test('byte-aware batching and overall worst-case speed budget cannot be bypassed by chunks',()=>{
 const heavy=nodes.slice(0,90).map(n=>({...n,url:'trojan://'+ 'x'.repeat(16000)}));
 assert.ok(makeProbePlan(heavy,['tcp'],['a'],{downloadBytes:65536}).chunks.length>1);
 assert.throws(()=>makeProbePlan(nodes,['speed'],['a','b'],{downloadBytes:5*1024**2}),/job_traffic_limit/);
});
test('format-only does not require or send a detector identity',()=>{
 const p=makeProbePlan(nodes,['format'],['a'],{}); assert.equal(p.network,false);assert.deepEqual(p.chunks[0].agentIds,[]);
});
