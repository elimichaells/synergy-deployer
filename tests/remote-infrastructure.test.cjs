const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {randomUUID}=require('node:crypto');
const agent=require('../scripts/manager-agent.cjs');
const load=require('./server-module.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-infrastructure-test-'));t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-infrastructure-test-'));await fs.rm(root,{recursive:true,force:true})});return root}

test('process controls use only registered private PM2 names and persist stops',async t=>{
  const root=await fixture(t),id=randomUUID(),other=randomUUID(),calls=[];
  await agent.atomicJson(path.join(root,'apps.json'),{[id]:{app:{id,name:'Fixture',port:32010},ecosystem:path.join(root,'ecosystem.config.js')}});
  const tools={pm:async args=>{calls.push(args);return '[]'}};
  const run=(action,target=id)=>agent.infrastructureJob(root,{payload:{id:target,action,expiresAt:Date.now()+60000}},tools,()=>{});
  await run('stop');assert.deepEqual(calls,[['jlist'],['stop',`manager-remote-${id}`],['save','--force']]);
  calls.length=0;await assert.rejects(run('stop',other),/Unknown managed/);await assert.rejects(run('delete'),/Unknown managed/);
  await assert.rejects(agent.infrastructureJob(root,{payload:{id,action:'restart',expiresAt:1}},tools,()=>{}),/expired/);assert.equal(calls.length,0);
});
test('shared proxies cannot be stopped or restarted by infrastructure actions',async t=>{
  const root=await fixture(t);let writes=0;
  for(const action of ['start','stop','restart'])await assert.rejects(agent.infrastructureJob(root,{payload:{action,expiresAt:Date.now()+60000}},{sharedProxy:{},pm:async()=>writes++},()=>{}),/existing sites/);
  assert.equal(writes,0);
});
test('shared proxy inspection reads the active routes rather than a stale source Caddyfile',async t=>{
  const root=await fixture(t),server=http.createServer((_req,res)=>{res.setHeader('etag','fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify({apps:{http:{servers:{existing:{routes:['existing-site','managed-site']}}}}}))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const value=await agent.infrastructureJob(root,{payload:{action:'read-config',expiresAt:Date.now()+60000}},{sharedProxy:{admin:`http://127.0.0.1:${server.address().port}`}},()=>{});
  assert.match(value.config,/existing-site/);assert.match(value.config,/managed-site/);assert.ok(value.configReadAt);
});
test('console directory changes persist a literal contained directory without executing shell expressions',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'console','child folder'),{recursive:true});
  const run=command=>agent.consoleJob(root,{kind:'console',payload:{command,expiresAt:Date.now()+60000}}, {},()=>{});
  assert.equal((await run('cd "child folder"')).cwd,await fs.realpath(path.join(root,'console','child folder')));
  await assert.rejects(run('cd ..'),/stay inside/);await assert.rejects(run('cd child; echo forbidden'),/literal directory/);
});
test('continuous readiness distinguishes HTTP failures, redirects, paused and missing processes',async t=>{
  const server=http.createServer((req,res)=>{res.statusCode=req.url==='/ready'?200:req.url==='/redirect'?302:503;res.end('fixture')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const ids=Array.from({length:4},()=>randomUUID()),saved=Object.fromEntries(ids.map((id,index)=>[id,{app:{id,port:server.address().port,health_path:['/ready','/redirect','/bad','/ready'][index]}}]));
  const list=ids.slice(0,3).map((id,index)=>({name:`manager-remote-${id}`,pid:100+index,pm2_env:{status:index===2?'stopped':'online',restart_time:2,pm_uptime:Date.now()},monit:{cpu:1,memory:20}}));
  const result=await agent.sampleApplications(saved,list,false),byId=new Map(result.map(row=>[row.id,row]));
  assert.equal(byId.get(ids[0]).check.ok,true);assert.equal(byId.get(ids[1]).check.ok,false);assert.equal(byId.get(ids[1]).check.status,302);assert.equal(byId.get(ids[2]).check,null);assert.equal(byId.get(ids[3]).status,'missing');
  assert.equal(byId.get(ids[0]).restarts,2);assert.equal((await agent.sampleApplications(saved,[],true))[0].check,null);
});
test('managed domain aliases survive deployment config generation without duplicating IP routes',async t=>{
  const root=await fixture(t),id=randomUUID(),domainId=randomUUID(),app={id,name:'Alias fixture',repo_url:'https://github.com/example/test',branch:'main',start_cmd:'node app.cjs',hostname:'primary.example.com',port:32010,health_path:'/',access_mode:'wan',ip_address:'192.0.2.10',ip_port:8443};
  await agent.atomicJson(path.join(root,'domains.json'),{[domainId]:{appId:id,hostname:'alias.example.com'},[randomUUID()]:{appId:randomUUID(),hostname:'other.example.com'}});
  const config=await agent.managedCaddyConfig(root,[app]);assert.match(config,/alias.example.com/);assert.match(config,/primary.example.com/);assert.doesNotMatch(config,/other.example.com/);assert.equal(config.match(/192\.0\.2\.10:8443/g)?.length,1);
});
test('remote admissions reject offline/old agents, foreign apps and concurrent work before creating a job',async()=>{
  for(const scenario of ['offline','old','foreign','busy','shared']){
    let inserted=false;const serverId=randomUUID(),appId=randomUUID();
    const client={release(){},query:async sql=>{
      if(sql.includes('select * from managed_servers'))return{rows:[{enabled:true,last_seen_at:scenario==='offline'?new Date(0):new Date(),metrics:{capabilities:scenario==='old'?[]:[agent.INFRASTRUCTURE_CAPABILITY],caddy:{mode:'shared'}}}]};
      if(sql.includes('from remote_apps'))return{rows:[],rowCount:scenario==='foreign'?0:1};
      if(sql.includes('union all'))return{rows:[],rowCount:scenario==='busy'?1:0};
      if(sql.includes('insert into remote_jobs'))inserted=true;
      return{rows:[],rowCount:0};
    }};
    const mod=load('lib/remote-infrastructure.ts',{'./api':{ApiError},'./audit':{audit:async()=>{}},'./db':{db:{connect:async()=>client}},'./managed-servers':{ensureManagedServers:async()=>{},uuid:x=>x},'./secret-crypto':{encryptSecret:x=>x},'@/scripts/manager-agent.cjs':agent});
    await assert.rejects(mod.queueInfrastructure(serverId,scenario==='shared'?null:appId,'stop',randomUUID()),e=>e.status===409);assert.equal(inserted,false,scenario);
  }
});

test('real PostgreSQL infrastructure admission, claims, reports, health retention and repeat migrations',{skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pool=new(require('pg').Pool)({connectionString:url.href});t.after(()=>pool.end());const query=(s,p)=>pool.query(s,p);
  await query('create extension if not exists pgcrypto;create table if not exists users(id uuid primary key);create table if not exists github_connections(id uuid primary key)');
  const user=randomUUID();await query('insert into users values($1)',[user]);process.env.MANAGER_ENCRYPTION_KEY='isolated-parity-test-key';
  const secret=load('lib/secret-crypto.ts',{}),mocks={'@/lib/db':{db:pool,query},'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':secret,'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':agent,'@/lib/remote-setup-policy':require('../lib/remote-setup-policy.ts')};
  const managed=load('lib/managed-servers.ts',mocks),server=await managed.addServer({name:'Parity fixture',platform:'win32'},user);
  await managed.enroll({protocol:1,platform:'win32',serverId:server.id,enrollmentToken:server.enrollmentToken,agentToken:require('crypto').randomBytes(32).toString('base64url')});
  const app=await managed.saveRemoteApp(server.id,null,{name:'Fixture',repo_url:'https://github.com/example/fixture',branch:'main',port:33001,start_cmd:'node app.cjs',access_mode:'lan',hostname:randomUUID()+'.example.test'},user);
  await query('update remote_apps set live_commit=$2 where id=$1',[app.id,'a'.repeat(40)]);
  const metrics={hostname:'fixture',platform:'win32',version:agent.AGENT_VERSION,cpuPercent:1,memoryTotal:16*1024**3,memoryFree:12*1024**3,diskTotal:200*1024**3,diskFree:150*1024**3,uptime:10,tools:{node:'24',git:null,pm2:null,caddy:null},addresses:[],apps:[{id:app.id,status:'online',cpu:1,memory:20,restarts:0,check:{ok:false,status:503,ms:10,reason:'fixture'}}],capabilities:[agent.INFRASTRUCTURE_CAPABILITY,agent.CONSOLE_CAPABILITY]};
  await query('update managed_servers set metrics=$2,last_seen_at=now() where id=$1',[server.id,JSON.stringify(metrics)]);
  const infra=load('lib/remote-infrastructure.ts',{'./api':{ApiError},'./audit':{audit:async()=>{}},'./db':{db:pool,query},'./managed-servers':managed,'./secret-crypto':secret,'@/scripts/manager-agent.cjs':agent});
  const queued=await Promise.allSettled([infra.queueInfrastructure(server.id,app.id,'stop',user),infra.queueInfrastructure(server.id,app.id,'restart',user)]);
  assert.equal(queued.filter(r=>r.status==='fulfilled').length,1);
  const {job}=await managed.claimJob(server.id);assert.equal(job.kind,'infrastructure');assert.equal(job.payload.requiredCapability,agent.INFRASTRUCTURE_CAPABILITY);
  await assert.rejects(managed.reportJob(randomUUID(),{id:job.id,claimToken:job.claimToken,status:'success',sequence:1,log:'fixture',result:{ok:true}}),e=>e.status===404);
  await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'success',sequence:1,log:'fixture complete',result:{ok:true}});
  assert.equal((await infra.remoteInfrastructureJob(server.id,job.id,false)).job.status,'success');
  await assert.rejects(infra.remoteInfrastructureJob(randomUUID(),job.id,true),e=>e.status===404);
  await load('lib/managed-servers.ts',mocks).ensureManagedServers();
  await query(await fs.readFile(path.resolve(__dirname,'../db/migrations/028_remote_operations.sql'),'utf8')); // Previous Manager can reapply its migration after rollback.
  const health=load('lib/remote-health.ts',{'./db':{db:pool,query},'./managed-servers':managed,'@/scripts/manager-agent.cjs':agent,'@/scripts/server-monitor-policy.cjs':require('../scripts/server-monitor-policy.cjs'),'@/scripts/health-history.cjs':require('../scripts/health-history.cjs')});
  await health.recordRemoteHealth(server.id,metrics);
  assert.equal((await health.remoteHealth(server.id)).incidents.length,0);
  await query("update remote_health set state=jsonb_set(state,'{checkedAt}',to_jsonb((now()-interval '61 seconds')::text)) where server_id=$1",[server.id]);
  await health.recordRemoteHealth(server.id,metrics);assert.equal((await health.remoteHealth(server.id)).incidents.length,1);
  await query("update managed_servers set last_seen_at=now()-interval '5 minutes' where id=$1",[server.id]);assert.equal((await health.remoteHealth(server.id)).stale,true);
  assert.ok((await health.remoteHealth(server.id,'24h')).summary.failed>0);
  // Exercise manual DNS through the real queue without contacting DNS providers or host Caddy.
  await query('create table if not exists projects(id uuid primary key)');
  await query('update managed_servers set last_seen_at=now() where id=$1',[server.id]);
  const cf=load('lib/cloudflare.ts',{'@/lib/managed-servers':managed,'@/lib/api':{ApiError},'@/lib/db':{query},'@/lib/secret-crypto':secret,'@/lib/caddy':{updateCaddyStrict:()=>{throw Error('Host Caddy must never be called')}}});
  const domains=load('lib/remote-domains.ts',{'./api':{ApiError},'./db':{db:pool,query},'./managed-servers':managed,'./secret-crypto':secret,'./cloudflare':cf,'./remote-infrastructure':infra});
  let running=false;const errors=[];const timer=setInterval(async()=>{if(running)return;running=true;try{const {job}=await managed.claimJob(server.id);if(job){assert.equal(job.payload.action,'domain');await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'success',sequence:1,log:'fixture route ack',result:{ok:true}})}}catch(error){errors.push(error)}finally{running=false}},20);
  try{
    const name=randomUUID()+'.example.com';
    await domains.createRemoteDomain(server.id,{projectId:app.id,hostname:name,mode:'manual',recordType:'A',recordContent:'192.0.2.10',isPrimary:true},user);
    const listed=await domains.listRemoteDomains(server.id),domain=listed.find(d=>d.hostname===name);assert.equal(domain.dns_status,'manual');assert.equal(domain.operation_status,'success');
    assert.equal((await managed.serverDetail(server.id)).apps[0].hostname,name);
    await assert.rejects(domains.deleteRemoteDomain(randomUUID(),domain.id,user),e=>e.status===404);
    await domains.deleteRemoteDomain(server.id,domain.id,user);assert.ok(!(await domains.listRemoteDomains(server.id)).some(d=>d.id===domain.id));
    assert.equal(errors.length,0);
  }finally{clearInterval(timer);while(running)await new Promise(resolve=>setTimeout(resolve,10))}
});
