import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../../',import.meta.url));
const id='99999999-2222-4333-8444-555555555555';
const biz='11111111-2222-4333-8444-555555555555';
const list=(values=[])=>({suffix:'/d1/database?name=misub-probes&per_page=100',body:{success:true,result:values}});
function run(t,steps=[],overrides={},existing='',deploy=false) {
 const dir=mkdtempSync(join(tmpdir(),'misub-probe-deploy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'http.json'),JSON.stringify(steps));writeFileSync(join(dir,'commands'), '');
 const curl=`#!${process.execPath}\nconst fs=require('node:fs'),assert=require('node:assert/strict');const a=process.argv.slice(2);const opt=n=>a.includes(n)?a[a.indexOf(n)+1]:undefined;const p=process.env.MOCK_HTTP;const s=JSON.parse(fs.readFileSync(p));const x=s.shift();assert.ok(x,'Unexpected HTTP');assert.ok(a.at(-1).endsWith(x.suffix),'Wrong endpoint');assert.equal(opt('--request')||'GET',x.method||'GET');fs.writeFileSync(p,JSON.stringify(s));const b=JSON.stringify(x.body);if(opt('--output'))fs.writeFileSync(opt('--output'),b);else process.stdout.write(b);if(opt('--write-out'))process.stdout.write(String(x.status||200));if(a.includes('--fail')&&(x.status||200)>=400)process.exit(22);`;
 writeFileSync(join(dir,'curl'),curl,{mode:0o700});
 writeFileSync(join(dir,'npx'),`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_COMMANDS,JSON.stringify(a)+'\\n');if(a.includes('secret'))fs.readFileSync(0);`,{mode:0o700});
 copyFileSync(join(root,'wrangler-cf-pages.toml'),join(dir,'wrangler-cf-pages.toml'));
 const env={PATH:`${dir}:${process.env.PATH}`,HOME:dir,MOCK_HTTP:join(dir,'http.json'),MOCK_COMMANDS:join(dir,'commands'),PROVISION_NODE_PROBES:'true',CLOUDFLARE_API_TOKEN:'offline-fixture-token',CLOUDFLARE_ACCOUNT_ID:'0'.repeat(32),ADMIN_PASSWORD:'offline-fixture-password',GITHUB_SHA:'b'.repeat(40),...overrides};
 const script=join(root,'scripts',deploy?'deploy-cloudflare-pages.sh':'provision-probe-d1.sh');
 const r=spawnSync('bash',[script,...(deploy?[]:['misub',existing])],{cwd:dir,env,encoding:'utf8',timeout:15000});
 assert.ifError(r.error);const text=r.stdout+r.stderr;assert.ok(!text.includes(env.CLOUDFLARE_API_TOKEN));assert.ok(!text.includes(env.ADMIN_PASSWORD));
 return {...r,dir,steps:JSON.parse(readFileSync(env.MOCK_HTTP)),commands:readFileSync(env.MOCK_COMMANDS,'utf8')};
}
test('creates missing isolated D1 and returns only UUID',t=>{
 const r=run(t,[list(),{suffix:'/d1/database',method:'POST',body:{success:true,result:{uuid:id}}}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),id);assert.deepEqual(r.steps,[]);
});
test('retries reuse exact stable name without a second creation',t=>{
 const r=run(t,[list([{name:'unrelated',uuid:biz},{name:'misub-probes',uuid:id}])]);assert.equal(r.status,0);assert.equal(r.stdout.trim(),id);assert.deepEqual(r.steps,[]);
});
test('bound probe database is preserved even with provisioning disabled',t=>{
 const r=run(t,[],{PROVISION_NODE_PROBES:'false'},id);assert.equal(r.status,0);assert.equal(r.stdout.trim(),id);
});
test('D1 authorization failure is explicit and performs no writes',t=>{
 const r=run(t,[{suffix:'/d1/database?name=misub-probes&per_page=100',status:403,body:{success:false}}]);assert.notEqual(r.status,0);assert.match(r.stderr,/D1 \/ Edit/);assert.deepEqual(r.steps,[]);assert.equal(r.stdout,'');
});
test('refuses explicit replacement or malformed resource identifier',t=>{
 assert.notEqual(run(t,[],{CLOUDFLARE_PROBE_D1_DATABASE_ID:biz},id).status,0);
 assert.notEqual(run(t,[],{},'not-a-uuid').status,0);
});
test('ambiguous database names fail closed',t=>{
 const r=run(t,[list([{name:'misub-probes',uuid:id},{name:'misub-probes',uuid:biz}])]);assert.notEqual(r.status,0);assert.match(r.stderr,/Ambiguous/);
});
const project=(probe=id)=>({suffix:'/pages/projects/misub',body:{success:true,result:{deployment_configs:{production:{kv_namespaces:{MISUB_KV:{namespace_id:'a'.repeat(32)}},d1_databases:{MISUB_DB:{id:biz},MISUB_PROBE_DB:{id:probe}}}}}}});
test('full deploy preserves KV, business D1 and probe D1 simultaneously',t=>{
 const r=run(t,[project()],{},'',true);assert.equal(r.status,0,r.stderr);assert.deepEqual(r.steps,[]);
 const cfg=readFileSync(join(r.dir,'wrangler.toml'),'utf8');for(const value of ['a'.repeat(32),biz,id,'MISUB_KV','MISUB_DB','MISUB_PROBE_DB'])assert.ok(cfg.includes(value));assert.match(r.commands,/pages.*deploy/);
});
test('full deploy refuses to share the business database with probe tasks',t=>{
 const r=run(t,[project(biz)],{},'',true);assert.notEqual(r.status,0);assert.match(r.stdout,/separate from MISUB_DB/);assert.equal(r.commands,'');
});
