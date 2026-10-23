const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const S=require('../scripts/manager-update-state.cjs');
const P=require('../scripts/manager-update-package.cjs');
const W=require('../scripts/manager-update-worker.cjs');
const load=require('./server-module.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-update-test-'));
  t.after(()=>{if(!root.startsWith(path.join(os.tmpdir(),'manager-update-test-')))throw new Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true})});
  const c={managerRoot:path.join(root,'manager'),stateRoot:path.join(root,'recovery'),pm2Home:path.join(root,'pm2'),port:4000};
  const dir=path.join(c.stateRoot,'job');
  for(const folder of [c.managerRoot,path.join(dir,'stage')])fs.mkdirSync(folder,{recursive:true});
  for(const [rel,text] of [['.next/BUILD_ID','old'],['scripts/runner.cjs','old script'],['.env.local','preserved secret']]){const file=path.join(c.managerRoot,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
  for(const [rel,text] of [['.next/BUILD_ID','new'],['scripts/runner.cjs','new script'],['release-source.json','new receipt']]){const file=path.join(dir,'stage',rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text)}
  const state={id:crypto.randomUUID(),phase:'queued',version:'2.22.0',fromVersion:'2.21.0',createdAt:new Date().toISOString(),events:[]};
  return {c,dir,state};
}
test('release compatibility rejects downgrades, unsupported runtime, and breaking schema',()=>{
  const m={format:1,repository:P.REPOSITORY,version:'2.22.0',minimumVersion:'2.21.0',sourceCommit:'a'.repeat(40),schemaCompatibility:'additive',payloadSha256:'b'.repeat(64),payloadBytes:100,platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0])};
  assert.doesNotThrow(()=>P.manifestCheck(m,'2.21.0'));
  for(const change of [{version:'2.21.0'},{version:'2.19.0'},{minimumVersion:'2.22.0'},{repository:'attacker/repo'},{nodeMajor:1},{arch:'other'},{schemaCompatibility:'breaking'},{payloadSha256:'short'}])assert.throws(()=>P.manifestCheck({...m,...change},'2.21.0'));
});
test('archive policy rejects traversal, Windows aliases, links, duplicates and unapproved roots',async t=>{
  for(const name of ['../secret','/etc/file','C:/file','node_modules/../.env.local','node_modules\\file','app/a:stream','app/NUL.txt','app/foo.','app/foo ','app//file','.env.local','.git/config'])assert.throws(()=>P.safeEntry(name,{type:'File'}));
  for(const type of ['SymbolicLink','Link','FIFO','CharacterDevice'])assert.throws(()=>P.safeEntry('app/page.tsx',{type}));
  assert.equal(P.safeEntry('app/page.tsx',{type:'File'}),'app/page.tsx');
  const {dir}=fixture(t);fs.writeFileSync(path.join(dir,'manifest.json'),'{}');
  const tar=require('tar'),file=path.join(dir,'duplicates.tar');
  await tar.c({file,cwd:dir},['manifest.json','manifest.json']);
  await assert.rejects(P.extract(file,path.join(dir,'out'),true),/Duplicate/);
});
test('only the administrator bootstrap can bridge older Managers or replace an explicit local preview',()=>{
  const m={format:1,repository:P.REPOSITORY,version:'2.21.0',minimumVersion:'2.21.0',bootstrapMinimumVersion:'2.17.0',sourceCommit:'a'.repeat(40),schemaCompatibility:'additive',payloadSha256:'b'.repeat(64),payloadBytes:100,platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0])};
  const check=(current,options={},manifest=m)=>P.manifestCheck(manifest,current,process.platform,process.arch,m.nodeMajor,options);
  assert.throws(()=>check('2.20.0'),/bridge/);
  assert.doesNotThrow(()=>check('2.17.0',{bootstrap:true}));
  assert.doesNotThrow(()=>check('2.20.0',{bootstrap:true}));
  assert.throws(()=>check('2.16.0',{bootstrap:true}),/bridge/);
  assert.throws(()=>check('2.21.0',{bootstrap:true}),/not newer/);
  assert.doesNotThrow(()=>check('2.21.0',{bootstrap:true,localBootstrap:true}));
  assert.throws(()=>check('2.22.0',{bootstrap:true,localBootstrap:true}),/not newer/);
  assert.throws(()=>check('2.20.0',{bootstrap:true},{...m,version:'2.22.0'}),/bridge/);
});
test('bootstrap uses the production build version and only accepts an explicitly labelled local preview',t=>{
  const {c}=fixture(t),B=require('../scripts/bootstrap-manager-upgrade.cjs');
  S.atomic(path.join(c.managerRoot,'.next/required-server-files.json'),{config:{env:{NEXT_PUBLIC_MANAGER_VERSION:'2.17.0'}}});
  S.atomic(path.join(c.managerRoot,'package.json'),{version:'2.21.0'});
  assert.equal(B.installed(c.managerRoot).version,'2.17.0');
  S.atomic(path.join(c.managerRoot,'release-source.json'),{version:'2.17.0',sourceDirty:true});
  assert.equal(B.installed(c.managerRoot).localBootstrap,false);
  S.atomic(path.join(c.managerRoot,'release-source.json'),{version:'2.17.0',sourceDirty:true,buildKind:'local-bootstrap'});
  assert.equal(B.installed(c.managerRoot).localBootstrap,true);
});
for(const point of ['after-old','after-new'])for(const name of ['.next','scripts','release-source.json']) {
  test(`power loss ${point} ${name} restores the original release, idempotently`,t=>{
    const {c,dir,state}=fixture(t);
    assert.throws(()=>S.activate(c,dir,state,(p,n)=>{if(p===point&&n===name)throw new Error('power loss')}));
    const journal=S.json(path.join(dir,'state.json'));
    S.restore(c,dir,journal);S.restore(c,dir,journal);
    assert.equal(fs.readFileSync(path.join(c.managerRoot,'.next/BUILD_ID'),'utf8'),'old');
    assert.equal(fs.readFileSync(path.join(c.managerRoot,'scripts/runner.cjs'),'utf8'),'old script');
    assert.equal(fs.readFileSync(path.join(c.managerRoot,'.env.local'),'utf8'),'preserved secret');
    assert.equal(fs.existsSync(path.join(c.managerRoot,'release-source.json')),false);
  });
}
for(const point of ['after-failed','after-restored'])test(`a second power loss ${point} during recovery is resumable`,t=>{
  const {c,dir,state}=fixture(t);S.activate(c,dir,state);
  assert.throws(()=>S.restore(c,dir,state,(p,n)=>{if(p===point&&n==='.next')throw new Error('second power loss')}));
  S.restore(c,dir,S.json(path.join(dir,'state.json')));
  assert.equal(fs.readFileSync(path.join(c.managerRoot,'.next/BUILD_ID'),'utf8'),'old');
});
test('staging integrity rejects changed and injected files',async t=>{
  const {dir}=fixture(t),stage=path.join(dir,'stage');
  S.atomic(path.join(dir,'inventory.json'),await P.inventory(stage));await W.integrity(dir);
  fs.writeFileSync(path.join(stage,'extra'),'unexpected');await assert.rejects(W.integrity(dir),/file list/);fs.unlinkSync(path.join(stage,'extra'));
  fs.writeFileSync(path.join(stage,'.next/BUILD_ID'),'tampered');await assert.rejects(W.integrity(dir),/integrity/);
});
test('untrusted proof is rejected before any application code is extracted',async t=>{
  const {dir}=fixture(t),tar=require('tar');
  const payload=path.join(dir,'payload.tar.gz');await tar.c({cwd:path.join(dir,'stage'),file:payload,gzip:true},['.next','scripts','release-source.json']);
  const m={format:1,repository:P.REPOSITORY,version:'2.22.0',minimumVersion:'2.21.0',sourceCommit:'a'.repeat(40),schemaCompatibility:'additive',payloadSha256:await P.sha(payload),payloadBytes:fs.statSync(payload).size,platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0])};
  S.atomic(path.join(dir,'manifest.json'),m);S.atomic(path.join(dir,'provenance.json'),{subject:[{digest:{sha256:await P.sha(payload)}}]});
  const archive=path.join(dir,'untrusted.tar');await tar.c({cwd:dir,file:archive},['manifest.json','provenance.json','payload.tar.gz']);
  const destination=path.join(dir,'verify');fs.mkdirSync(destination);
  await assert.rejects(P.verifyAndStage(archive,destination,'2.21.0',path.join(__dirname,'../scripts/update-trusted-root.json')));
  assert.equal(fs.existsSync(path.join(destination,'stage')),false);
});
function services(c,events){
  return {
    processes:async()=>['manager','manager-phpmyadmin','customer-app','manager-caddy'].map(name=>({name,pm2_env:{status:'online',pm_cwd:c.managerRoot,pm_exec_path:path.join(c.managerRoot,'node_modules/next/dist/bin/next'),PM2_HOME:c.pm2Home}})),
    integrity:async()=>events.push('verified'),assertIdle:async()=>events.push('idle'),sleep:async()=>{},
    backup:async()=>events.push('backup'),pm2:async(_c,verb,name)=>events.push(`${verb}:${name}`),health:async()=>events.push('healthy')
  };
}
test('successful activation backs up before replacing files and leaves hosted apps alone',async t=>{
  const {c,dir,state}=fixture(t),events=[],ops=services(c,events);
  await W.apply(c,dir,state,ops);
  assert.equal(state.phase,'succeeded');assert.equal(S.maintenance(c.managerRoot),false);
  assert.ok(events.indexOf('backup')<events.indexOf('restart:manager'));
  assert.deepEqual(events.filter(s=>s.includes(':')),['stop:manager','stop:manager-phpmyadmin','restart:manager','restart:manager-phpmyadmin']);
  assert.equal(fs.readFileSync(path.join(dir,'previous/.next/BUILD_ID'),'utf8'),'old');
});
test('failed readiness recovers the old build and retains the failed candidate',async t=>{
  const {c,dir,state}=fixture(t),events=[],ops=services(c,events);
  ops.health=async()=>{throw new Error('bad health')};await assert.rejects(W.apply(c,dir,state,ops),/bad health/);
  await W.recover(c,dir,state,false,services(c,events));
  assert.equal(state.phase,'rolled_back');assert.equal(S.maintenance(c.managerRoot),false);
  assert.equal(fs.readFileSync(path.join(c.managerRoot,'.next/BUILD_ID'),'utf8'),'old');
  assert.equal(fs.readFileSync(path.join(dir,'failed/.next/BUILD_ID'),'utf8'),'new');
});
test('active work and a failed backup never activate a release',async t=>{
  const {c,dir,state}=fixture(t),events=[],ops=services(c,events);
  ops.assertIdle=async()=>{throw new Error('deployment active')};await assert.rejects(W.apply(c,dir,state,ops),/deployment active/);
  assert.equal(events.some(s=>s.startsWith('stop:')),false);
  ops.assertIdle=async()=>{};ops.backup=async()=>{throw new Error('dump failed')};await assert.rejects(W.apply(c,dir,state,ops),/dump failed/);
  await W.recover(c,dir,state,false,services(c,events));
  assert.equal(fs.readFileSync(path.join(c.managerRoot,'.next/BUILD_ID'),'utf8'),'old');
  assert.equal(fs.existsSync(path.join(dir,'previous')),false);
});
test('recovery remains in maintenance if the old release cannot pass health checks',async t=>{
  const {c,dir,state}=fixture(t),events=[],ops=services(c,events);await W.apply(c,dir,state,ops);
  S.atomic(path.join(c.managerRoot,'.manager-maintenance.json'),{id:state.id});
  ops.health=async()=>{throw new Error('still offline')};await assert.rejects(W.recover(c,dir,state,false,ops),/still offline/);
  assert.equal(S.maintenance(c.managerRoot),true);
});
test('maintenance blocks work, webhooks and agent claims while retaining readiness and authenticated recovery',()=>{
  const {NextRequest}=require('next/server');
  const {middleware}=load('middleware.ts',{'./scripts/manager-update-state.cjs':{maintenance:()=>true}});
  for(const url of ['/api/sites','/api/webhooks/github','/api/server-agent/claim','/api/servers'])assert.equal(middleware(new NextRequest('https://manager'+url,{method:'POST'})).status,503);
  assert.equal(middleware(new NextRequest('https://manager/api/wake')).status,503);
  assert.equal(middleware(new NextRequest('https://manager/api/manager-health')).status,200);
  assert.equal(middleware(new NextRequest('https://manager/api/manager-updates',{method:'POST'})).status,401);
  assert.equal(middleware(new NextRequest('https://manager/api/manager-updates',{method:'POST',headers:{cookie:'manager_session=test'}})).status,200);
});
test('update API requires an active administrator and same-origin mutations',async()=>{
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  let role='viewer',calls=0;
  const rbac=load('lib/rbac.ts',{'./api':{ApiError}});
  const route=load('app/api/manager-updates/route.ts',{
    '@/lib/auth':{getSessionFromCookie:async()=>role?{id:'user',role}:null},'@/lib/rbac':rbac,
    '@/lib/api':{jsonError:e=>Response.json({error:e.message},{status:e.status||500})},
    '@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':{ApiError}}),
    '@/lib/manager-updates':Object.fromEntries(['latestRelease','prepareUpdate','updateAction','updateStatus'].map(name=>[name,async()=>{calls++;return {ok:true}}]))
  });
  const req=(origin='https://manager',body='{}')=>new Request('https://manager/api/manager-updates',{method:'POST',headers:{host:'manager',origin,'content-type':'application/json'},body});
  for(role of [null,'viewer','operator']){assert.equal((await route.GET(new Request('https://manager/api/manager-updates'))).status,role?403:401);assert.equal((await route.POST(req())).status,role?403:401)}
  role='admin';assert.equal((await route.POST(req('https://attacker'))).status,403);
  assert.equal((await route.POST(req('https://manager',JSON.stringify({action:'install',padding:'x'.repeat(2100)})))).status,413);assert.equal(calls,0);
  assert.equal((await route.POST(req())).status,200);assert.equal(calls,1);
});
test('long operations hold a lease until completion and cannot start during maintenance',async t=>{
  const {c}=fixture(t);let paused=false,finish;
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const gate=load('lib/update-maintenance.ts',{'./api':{ApiError},'@/scripts/manager-update-state.cjs':{config:()=>c,maintenance:()=>paused}});
  const running=gate.updateProtected('SSH setup',()=>new Promise(resolve=>{finish=resolve}));
  const folder=path.join(c.stateRoot,'operations');assert.equal(fs.readdirSync(folder).length,1);
  finish('done');assert.equal(await running,'done');assert.equal(fs.readdirSync(folder).length,0);
  paused=true;await assert.rejects(gate.updateProtected('restore',async()=>{}),e=>e.status===503);assert.equal(fs.readdirSync(folder).length,0);
});
