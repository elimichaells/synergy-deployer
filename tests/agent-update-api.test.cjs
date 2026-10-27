const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const load=require('./server-module.cjs');
const agent=require('../scripts/manager-agent.cjs');
class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
const mocks={'@/lib/db':{},'@/lib/api':{ApiError},'@/lib/audit':{},'@/lib/managed-servers':{},'@/scripts/manager-agent.cjs':agent};
test('server version comparison is numeric and rejects ambiguous/downgrade versions',()=>{
  const {newerAgent}=load('lib/remote-agent-updates.ts',mocks);
  assert.equal(newerAgent('1.12.0','1.9.0'),true);assert.equal(newerAgent('1.2.0','1.2.0'),false);
  for(const installed of ['','garbage','v1.1.0','1.1.0-beta','2.0.0'])assert.equal(newerAgent('1.2.0',installed),false);
});
test('update API requires admin, same origin and a server-scoped action',async()=>{
  let role='viewer',called=0;
  const api={ApiError,jsonError:error=>Response.json({error:error.message},{status:error.status||500})};
  const route=load('app/api/servers/[[...path]]/route.ts',{
    '@/lib/auth':{getSessionFromCookie:async()=>role?{id:randomUUID(),role}:null},
    '@/lib/rbac':load('lib/rbac.ts',{'./api':{ApiError}}),'@/lib/api':api,
    '@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':{ApiError}}),
    '@/lib/managed-servers':{},'@/lib/remote-app-setup':{},
    '@/lib/remote-agent-updates':{queueAgentUpdate:async()=>{called++;return{id:randomUUID()};},cancelAgentUpdate:async()=>{called++;return{ok:true};}},
  });
  const context={params:Promise.resolve({path:[randomUUID(),'agent-update']})};
  const request=(origin='https://manager')=>new Request('https://manager/api/servers/id/agent-update',{method:'POST',headers:{host:'manager',origin,'Content-Type':'application/json'},body:'{"action":"update"}'});
  for(const r of ['viewer','operator',null]){role=r;assert.equal((await route.POST(request(),context)).status,role?403:401);}
  role='admin';assert.equal((await route.POST(request('https://foreign'),context)).status,403);assert.equal(called,0);
  assert.equal((await route.POST(request(),context)).status,202);assert.equal(called,1);
});
test('real PostgreSQL serializes updates with app claims, restricts scope, cancels safely and confirms heartbeats',{skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const {Pool}=require('pg');const pool=new Pool({connectionString:url.href,max:12});t.after(()=>pool.end());const query=(sql,values)=>pool.query(sql,values);
  await query('create extension if not exists pgcrypto; create table if not exists users(id uuid primary key); create table if not exists github_connections(id uuid primary key)');
  const userId=randomUUID();await query('insert into users(id) values($1)',[userId]);
  const previous=process.env.MANAGER_ENCRYPTION_KEY;process.env.MANAGER_ENCRYPTION_KEY='isolated-agent-update-fixture';t.after(()=>{if(previous===undefined)delete process.env.MANAGER_ENCRYPTION_KEY;else process.env.MANAGER_ENCRYPTION_KEY=previous;});
  const managed=load('lib/managed-servers.ts',{'@/lib/db':{db:pool,query},'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':load('lib/secret-crypto.ts',{}),'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':agent,'@/lib/remote-setup-policy':require('../lib/remote-setup-policy.ts')});
  const updates=load('lib/remote-agent-updates.ts',{...mocks,'@/lib/db':{db:pool,query},'@/lib/audit':{audit:async()=>{}},'@/lib/managed-servers':managed});
  const server=await managed.addServer({name:'Update lab',platform:process.platform},userId);
  const enrollment={serverId:server.id,enrollmentToken:server.enrollmentToken,agentToken:randomBytes(32).toString('base64url'),platform:process.platform,protocol:1};await managed.enroll(enrollment);
  const beforeEnrollment=(await query('select agent_hash,enrolled_at from managed_servers where id=$1',[server.id])).rows[0];
  const metrics={hostname:'fixture',platform:process.platform,version:'1.1.0',cpuPercent:0,memoryTotal:10,memoryFree:5,diskTotal:10,diskFree:5,uptime:1,addresses:[],tools:{},apps:[],capabilities:[]};
  const pulse=async(version='1.1.0',supported=true)=>managed.heartbeat({id:server.id,platform:process.platform},{protocol:1,metrics:{...metrics,version,capabilities:supported?[agent.UPDATE_CAPABILITY]:[]}});
  await pulse('1.1.0',false);await assert.rejects(updates.queueAgentUpdate(server.id,userId),/supervisor/);
  await pulse();
  const app=await managed.saveRemoteApp(server.id,null,{name:'App',repo_url:'https://github.com/example/test',branch:'main',start_cmd:'node app.js',port:3100,health_path:'/',access_mode:'lan',hostname:'app.campus.example.edu',environment:{}},userId);
  await managed.queueRemoteDeploy(server.id,app.id,userId);const running=await managed.claimJob(server.id);
  const concurrent=await Promise.allSettled([updates.queueAgentUpdate(server.id,userId),updates.queueAgentUpdate(server.id,userId)]);
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
  const first=concurrent.find(r=>r.status==='fulfilled').value;
  assert.equal((await updates.claimAgentUpdate(server.id,{version:'1.1.0',supervisorProtocol:1})).update,null,'Running deployment must finish first');
  await managed.reportJob(server.id,{id:running.job.id,claimToken:running.job.claimToken,status:'success',sequence:1,log:'',commitSha:'a'.repeat(40)});
  await managed.queueRemoteDeploy(server.id,app.id,userId);
  assert.equal((await managed.claimJob(server.id)).job,null,'Queued updates reserve the server before another deployment starts');
  await updates.cancelAgentUpdate(server.id,first.id,userId);
  const next=await managed.claimJob(server.id);assert.ok(next.job);
  await managed.reportJob(server.id,{id:next.job.id,claimToken:next.job.claimToken,status:'success',sequence:1,log:'',commitSha:'b'.repeat(40)});
  await updates.queueAgentUpdate(server.id,userId);
  const claims=await Promise.all([updates.claimAgentUpdate(server.id,{version:'1.1.0',supervisorProtocol:1}),updates.claimAgentUpdate(server.id,{version:'1.1.0',supervisorProtocol:1})]);
  assert.equal(claims[0].update.claimToken,claims[1].update.claimToken);
  const update=claims[0].update;
  const report={id:update.id,claimToken:update.claimToken,sequence:1,status:'success'};
  await assert.rejects(updates.cancelAgentUpdate(server.id,update.id,userId),/not started/);
  await assert.rejects(updates.reportAgentUpdate(randomUUID(),report),/belong/);
  await assert.rejects(updates.reportAgentUpdate(server.id,report),/heartbeat/);
  await pulse(agent.AGENT_VERSION);await updates.reportAgentUpdate(server.id,report);
  await updates.reportAgentUpdate(server.id,{...report,sequence:2,status:'failed'});
  const status=await updates.agentUpdateStatus(server.id);assert.equal(status.latest.status,'success');assert.equal(status.updateAvailable,false);
  assert.ok(!JSON.stringify(status).includes(update.claimToken));assert.ok(!JSON.stringify(status).includes('const AGENT_VERSION'));
  assert.equal((await query('select source from remote_agent_updates where id=$1',[update.id])).rows[0].source,null);
  assert.deepEqual((await query('select agent_hash,enrolled_at from managed_servers where id=$1',[server.id])).rows[0],beforeEnrollment);
  assert.equal((await managed.serverDetail(server.id)).apps[0].live_commit,'b'.repeat(40));
  await assert.rejects(updates.queueAgentUpdate(server.id,userId),/No newer/);
  await pulse('1.1.0');await query("update managed_servers set last_seen_at=now()-interval '2 minutes' where id=$1",[server.id]);
  await assert.rejects(updates.queueAgentUpdate(server.id,userId),/reconnect/);
});
