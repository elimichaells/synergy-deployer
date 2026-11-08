const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto'),load=require('./server-module.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
const api={ApiError,jsonError:error=>Response.json({error:error.message},{status:error.status||500})};

test('removal endpoints enforce admin, origin, bounded input and update maintenance',async()=>{
  let role='admin',calls=0,maintenance=false;
  const route=load('app/api/servers/[id]/removal/route.ts',{
    'next/server':{NextResponse:Response},'@/lib/api':api,
    '@/lib/auth':{getSessionFromCookie:async()=>role?{id:'fixture-user',role}:null},
    '@/lib/rbac':load('lib/rbac.ts',{'./api':api}),
    '@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':api}),
    '@/lib/server-removal':{reviewServerRemoval:async()=>{calls++;return{}},removeServer:async()=>{calls++;return{ok:true}}},
    '@/lib/update-maintenance':{updateProtected:(_operation,work)=>{if(maintenance)throw new ApiError('Updating',503);return work()}},
  });
  const context={params:Promise.resolve({id:randomUUID()})};
  const req=(origin='https://manager.test',body='{}')=>new Request('https://manager.test/api/servers/fixture/removal',{method:'DELETE',headers:{host:'manager.test',origin},body});
  for(role of [null,'viewer','operator']){assert.equal((await route.GET(req(),context)).status,role?403:401);assert.equal((await route.DELETE(req(),context)).status,role?403:401)}
  role='admin';assert.equal((await route.DELETE(req('https://foreign.test'),context)).status,403);
  assert.equal((await route.DELETE(req('https://manager.test','x'.repeat(5000)),context)).status,413);
  maintenance=true;assert.equal((await route.DELETE(req(),context)).status,503);assert.equal(calls,0);
  maintenance=false;const preview=await route.GET(req(),context);assert.equal(preview.status,200);assert.equal(preview.headers.get('cache-control'),'no-store');
  assert.equal((await route.DELETE(req(),context)).status,200);assert.equal(calls,2);
});

test('real PostgreSQL removes only reviewed server records and preserves external resources and audit', {skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/^\/manager_remote_test_/);
  const pool=new(require('pg').Pool)({connectionString:url.href,max:12}),query=(sql,args)=>pool.query(sql,args);t.after(()=>pool.end());
  await query('create extension if not exists pgcrypto; create table if not exists users(id uuid primary key); create table if not exists github_connections(id uuid primary key); create table if not exists projects(id uuid primary key); create table if not exists audit_logs(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),action text not null,resource text not null,details jsonb)');
  const user=randomUUID();await query('insert into users(id) values($1)',[user]);
  const managed=load('lib/managed-servers.ts',{'@/lib/api':api,'@/lib/db':{db:pool,query},'@/lib/audit':{audit:async()=>{}},'@/lib/git-provider-policy':{},'@/lib/github-connections':{},'@/lib/remote-setup-policy':{},'@/lib/secret-crypto':{},'@/scripts/manager-agent.cjs':require('../scripts/manager-agent.cjs')});
  const removal=load('lib/server-removal.ts',{'@/lib/api':api,'@/lib/db':{db:pool},'@/lib/managed-servers':managed});
  const create=name=>managed.addServer({name,platform:'win32'},user);
  const confirmed=async id=>{const r=await removal.reviewServerRemoval(id);return{reviewToken:r.reviewToken,confirmationName:r.server.name,acknowledged:true}};
  const pending=await create('Unused setup');
  assert.equal((await removal.reviewServerRemoval(pending.id)).requiresConfirmation,false);
  await assert.rejects(removal.removeServer('local',{},user),e=>e.status===400);
  await assert.rejects(removal.removeServer(pending.id,{},user),e=>e.status===409);
  await removal.removeServer(pending.id,{reviewToken:(await removal.reviewServerRemoval(pending.id)).reviewToken},user);
  await assert.rejects(managed.enroll({serverId:pending.id,enrollmentToken:pending.enrollmentToken,agentToken:randomBytes(32).toString('base64url'),platform:'win32',protocol:1}));
  await assert.rejects(removal.reviewServerRemoval(pending.id),e=>e.status===404);
  // Create real domain schema with all FK dependencies. No provider calls are permitted.
  const cf=load('lib/cloudflare.ts',{'@/lib/managed-servers':managed,'@/lib/api':api,'@/lib/db':{query},'@/lib/secret-crypto':{},'@/lib/caddy':{}});await cf.ensureCloudflareSchema();
  const target=await create('Production fixture'),other=await create('Preserve fixture'),token=randomBytes(32).toString('base64url');
  await managed.enroll({serverId:target.id,enrollmentToken:target.enrollmentToken,agentToken:token,platform:'win32',protocol:1});
  const auth=()=>managed.authenticateAgent(new Request('https://manager/api/server-agent/claim',{headers:{Authorization:`Bearer ${token}`}}));assert.equal((await auth()).id,target.id);
  const app=async(id,name,port,production=null)=>(await query("insert into remote_apps(server_id,name,repo_url,start_cmd,port,access_mode,hostname,env_ciphertext,production_id,deployed_at) values($1,$2,'https://example.com/repo','npm start',$3,'wan',$4,'encrypted fixture',$5,now()) returning id",[id,name,port,randomUUID()+'.example.com',production])).rows[0].id;
  const production=await app(target.id,'Production',33000),staging=await app(target.id,'Staging',33001,production),otherApp=await app(other.id,'Preserved',33000);
  const job=(await query("insert into remote_jobs(server_id,app_id,status,payload_ciphertext) values($1,$2,'queued','encrypted fixture') returning id",[target.id,production])).rows[0].id;
  const domain=randomUUID()+'.example.com';await query("insert into remote_domains(server_id,project_id,hostname,record_type,record_content,job_id) values($1,$2,$3,'A','192.0.2.10',$4)",[target.id,production,domain,job]);
  await query("insert into remote_agent_updates(server_id,from_version,target_version,sha256,source) values($1,'1.5','1.6','fixture','source')",[target.id]);
  const service=randomUUID();await query("insert into remote_service_operations(id,server_id,service_id,status,plan,credentials_ciphertext) values($1,$2,'postgresql','success','{}','encrypted fixture')",[service,target.id]);
  await query("insert into remote_health(server_id) values($1)",[target.id]);
  const r=await removal.reviewServerRemoval(target.id);assert.equal(r.requiresConfirmation,true);assert.equal(r.applications.length,2);assert.equal(r.domains.length,1);assert.equal(r.queuedOperations,2);
  const body=await confirmed(target.id);
  await assert.rejects(removal.removeServer(target.id,{...body,confirmationName:'wrong'},user),e=>e.status===400);
  await assert.rejects(removal.removeServer(target.id,{...body,acknowledged:false},user),e=>e.status===400);
  await query('update managed_servers set last_seen_at=now() where id=$1',[target.id]);assert.equal((await removal.reviewServerRemoval(target.id)).reviewToken,body.reviewToken);
  await query("update remote_apps set name='Renamed staging' where id=$1",[staging]);await assert.rejects(removal.removeServer(target.id,body,user),e=>e.status===409);
  // Active and unresolved work may never be discarded, even with a fresh review.
  for(const [table,status,reset] of [['remote_jobs','running','queued'],['remote_agent_updates','installing','queued'],['remote_agent_updates','recovery_required','queued'],['remote_service_operations','running','success'],['remote_service_operations','interrupted','success']]){
    await query(`update ${table} set status=$2 where server_id=$1`,[target.id,status]);const review=await removal.reviewServerRemoval(target.id);assert.ok(review.blockers.length);await assert.rejects(removal.removeServer(target.id,await confirmed(target.id),user),e=>e.status===409);await query(`update ${table} set status=$2 where server_id=$1`,[target.id,reset]);
  }
  const lease=await pool.connect();try{for(const namespace of ['manager-ssh-setup','manager-remote-domains']){await lease.query('select pg_advisory_lock(hashtext($1),hashtext($2))',[namespace,target.id]);await assert.rejects(removal.removeServer(target.id,body,user),e=>e.status===409);await lease.query('select pg_advisory_unlock(hashtext($1),hashtext($2))',[namespace,target.id])}}finally{lease.release()}
  // An agent claim that wins the server lock must prevent a simultaneous removal.
  const beforeClaim=await confirmed(target.id),claim=await pool.connect();let deletion;
  try{await claim.query('begin');await claim.query('select id from managed_servers where id=$1 for update',[target.id]);deletion=removal.removeServer(target.id,beforeClaim,user);const rejected=assert.rejects(deletion,e=>e.status===409);await claim.query("update remote_jobs set status='running' where id=$1",[job]);await claim.query('commit');await rejected}finally{await claim.query('rollback');claim.release()}
  await query("update remote_jobs set status='queued' where id=$1",[job]);
  await query("insert into remote_domain_operations(server_id,owner,expires_at) values($1,$2,now()+interval '3 minutes')",[target.id,randomUUID()]);await assert.rejects(removal.removeServer(target.id,await confirmed(target.id),user),e=>e.status===409);await query("update remote_domain_operations set expires_at=now()-interval '1 second' where server_id=$1",[target.id]);
  // Audit failure must restore all deleted records and agent authorization.
  await assert.rejects(removal.removeServer(target.id,await confirmed(target.id),randomUUID()),/foreign key/);assert.equal((await auth()).id,target.id);assert.equal((await removal.reviewServerRemoval(target.id)).applications.length,2);
  await removal.removeServer(target.id,await confirmed(target.id),user);
  for(const table of ['remote_apps','remote_jobs','remote_agent_updates','remote_service_operations','remote_health','remote_domains','remote_domain_operations'])assert.equal((await query(`select count(*)::int as n from ${table} where server_id=$1`,[target.id])).rows[0].n,0,table);
  await assert.rejects(auth(),e=>e.status===401);await assert.rejects(managed.claimJob(target.id),e=>e.status===401);
  assert.equal((await query('select id from remote_apps where id=$1',[otherApp])).rowCount,1);assert.equal((await query('select id from managed_servers where id=$1',[other.id])).rowCount,1);
  const audit=(await query("select details from audit_logs where action='server.remove' and resource=$1",[target.id])).rows[0].details;assert.equal(audit.preservedRemoteResources,true);assert.deepEqual(audit.domains,[domain]);
  // Revoked/offline connections also support removal, with the same strong confirmation.
  for(const enabled of [true,false]){const s=await create('Offline fixture');await query("update managed_servers set enrolled_at=now(),last_seen_at=now()-interval '1 day',enabled=$2 where id=$1",[s.id,enabled]);assert.equal((await removal.reviewServerRemoval(s.id)).requiresConfirmation,true);await removal.removeServer(s.id,await confirmed(s.id),user)}
});
