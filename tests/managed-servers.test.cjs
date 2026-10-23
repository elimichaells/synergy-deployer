const test = require('node:test');
const assert = require('node:assert/strict');
const {randomBytes,randomUUID} = require('node:crypto');
const load = require('./server-module.cjs');
const policy = require('../scripts/manager-agent.cjs');
class ApiError extends Error { constructor(message,status){super(message);this.status=status;} }
const fixture = overrides => ({name:'Library',repo_url:'https://github.com/example/library',branch:'main',install_cmd:'npm ci',build_cmd:'npm run build',start_cmd:'npm start',port:3100,health_path:'/health',access_mode:'lan',hostname:'library.campus.example.edu',environment:{TOKEN:'application-secret'},...overrides});

test('agent APIs reject cookie-only access, malformed credentials and invalid identifiers before issuing jobs',async()=>{
  let calls=0;
  const client={query:async()=>({rows:[]}),release(){}};
  const m=load('lib/managed-servers.ts',{'@/lib/db':{db:{connect:async()=>client},query:async()=>{calls++;return{rows:[]};}},
    '@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':{},'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':policy});
  await assert.rejects(m.authenticateAgent(new Request('https://manager/api/server-agent/claim',{headers:{Cookie:'manager_session=anything'}})),e=>e.status===401);
  assert.equal(calls,0);
  for(const value of ['x','../../file','00000000-0000-0000-0000-000000000000;drop table users'])assert.throws(()=>m.uuid(value));
});

test('real PostgreSQL enrollment, concurrent claims, multi-app isolation and durable reports', {skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL}, async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  assert.match(url.pathname,/^\/manager_remote_test_/,'Never run this integration test against the control database');
  const {Pool}=require('pg');
  const pool=new Pool({connectionString:url.href,max:15});
  t.after(()=>pool.end());
  const query=(sql,params)=>pool.query(sql,params);
  await query('create extension if not exists pgcrypto; create table if not exists users(id uuid primary key); create table if not exists github_connections(id uuid primary key)');
  const userId=randomUUID();await query('insert into users(id) values($1)',[userId]);
  const crypto=load('lib/secret-crypto.ts',{});
  const key=process.env.MANAGER_ENCRYPTION_KEY;process.env.MANAGER_ENCRYPTION_KEY='isolated-integration-fixture-key';
  t.after(()=>{if(key===undefined)delete process.env.MANAGER_ENCRYPTION_KEY;else process.env.MANAGER_ENCRYPTION_KEY=key;});
  const m=load('lib/managed-servers.ts',{'@/lib/db':{db:pool,query},'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},
    '@/lib/secret-crypto':crypto,'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':policy});
  const server=await m.addServer({name:'Campus',platform:'linux',location:'LAN'},userId);
  const agentToken=randomBytes(32).toString('base64url');
  const enrollment={serverId:server.id,enrollmentToken:server.enrollmentToken,agentToken,platform:'linux',protocol:1};
  await assert.rejects(m.enroll({...enrollment,platform:'win32'}));
  await m.enroll(enrollment);await m.enroll(enrollment);
  await assert.rejects(m.enroll({...enrollment,agentToken:randomBytes(32).toString('base64url')}));
  const auth=()=>m.authenticateAgent(new Request('https://manager/api/server-agent/claim',{headers:{Authorization:`Bearer ${agentToken}`}}));
  assert.equal((await auth()).id,server.id);
  const expired=await m.addServer({name:'Expired',platform:'win32'},userId);
  await query("update managed_servers set enrollment_expires_at=now()-interval '1 minute' where id=$1",[expired.id]);
  await assert.rejects(m.enroll({...enrollment,serverId:expired.id,enrollmentToken:expired.enrollmentToken,platform:'win32'}));

  const a=await m.saveRemoteApp(server.id,null,fixture({ip_address:'10.0.0.2',ip_port:8443}),userId);
  const b=await m.saveRemoteApp(server.id,null,fixture({name:'Records',hostname:'records.campus.example.edu',port:3200,ip_address:'10.0.0.2',ip_port:8444}),userId);
  assert.equal((await m.serverDetail(server.id)).apps.length,2);
  await assert.rejects(m.saveRemoteApp(server.id,null,fixture({hostname:'collision.campus.example.edu',port:8443}),userId),/already assigned/);
  const twin=await m.addServer({name:'Another campus',platform:'linux'},userId);
  await m.saveRemoteApp(twin.id,null,fixture(),userId); // Reusing backend ports on a different host is valid.
  const concurrent=await Promise.allSettled([m.queueRemoteDeploy(server.id,a.id,userId),m.queueRemoteDeploy(server.id,a.id,userId)]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
  await m.queueRemoteDeploy(server.id,b.id,userId);
  await assert.rejects(m.saveRemoteApp(server.id,a.id,fixture(),userId),/active deployment/);
  const [claim1,claim2]=await Promise.all([m.claimJob(server.id),m.claimJob(server.id)]);
  assert.equal(claim1.job.id,claim2.job.id);assert.equal(claim1.job.claimToken,claim2.job.claimToken);
  assert.equal(claim1.job.payload.environment.TOKEN,'application-secret');
  const first=claim1.job;
  await assert.rejects(m.reportJob(twin.id,{id:first.id,claimToken:first.claimToken,status:'success',sequence:1,log:'',commitSha:'a'.repeat(40)}));
  await m.reportJob(server.id,{id:first.id,claimToken:first.claimToken,status:'running',sequence:2,log:'Build application-secret'});
  await m.reportJob(server.id,{id:first.id,claimToken:first.claimToken,status:'running',sequence:1,log:'stale'});
  let detail=await m.serverDetail(server.id);
  assert.equal(detail.jobs.find(x=>x.id===first.id).log,'Build [redacted]');
  assert.ok(!JSON.stringify(detail).includes('application-secret'));
  await m.reportJob(server.id,{id:first.id,claimToken:first.claimToken,status:'success',sequence:3,log:'Done',commitSha:'a'.repeat(40)});
  await m.reportJob(server.id,{id:first.id,claimToken:first.claimToken,status:'failed',sequence:4,log:'late duplicate'});
  assert.equal((await query('select payload_ciphertext from remote_jobs where id=$1',[first.id])).rows[0].payload_ciphertext,null);
  detail=await m.serverDetail(server.id);
  assert.equal(detail.apps.find(x=>x.id===a.id).live_commit,'a'.repeat(40));
  const next=await m.claimJob(server.id);assert.equal(next.job.payload.id,b.id);
  assert.notEqual(next.job.id,first.id);
  await m.changeServer(server.id,'revoke',userId);
  await assert.rejects(auth());await assert.rejects(m.claimJob(server.id));
  assert.equal((await m.serverDetail(server.id)).server.status,'revoked');
  assert.equal((await query('select status,payload_ciphertext from remote_jobs where id=$1',[next.job.id])).rows[0].status,'cancelled');
});
