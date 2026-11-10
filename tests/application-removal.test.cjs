const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),load=require('./server-module.cjs'),agent=require('../scripts/manager-agent.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
const api={ApiError,jsonError:error=>Response.json({error:error.message},{status:error.status||500})};

test('application removal authorizes administrators, rejects cross origin and oversized input, and obeys maintenance',async()=>{
  let role='admin',calls=0,maintenance=false;
  const {applicationRemovalRequest:request}=load('lib/application-removal-route.ts',{
    'next/server':{NextResponse:Response},'@/lib/api':api,'@/lib/auth':{getSessionFromCookie:async()=>role?{id:'user',role}:null},
    '@/lib/rbac':load('lib/rbac.ts',{'./api':api}),'@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':api}),
    '@/lib/application-removal':{reviewApplicationRemoval:async()=>{calls++;return{}},removeApplication:async()=>{calls++;return{jobId:'job'}}},
    '@/lib/update-maintenance':{updateProtected:(_label,work)=>{if(maintenance)throw new ApiError('Updating',503);return work()}},
  });
  const req=(method='DELETE',origin='https://manager.test',body='{}')=>new Request('https://manager.test/api/sites/app/removal',{method,headers:{origin,host:'manager.test'},...(method==='GET'?{}:{body})});
  for(role of [null,'viewer','operator'])assert.equal((await request(req(),null,'app')).status,role?403:401);
  role='admin';assert.equal((await request(req('DELETE','https://foreign.test'),null,'app')).status,403);
  assert.equal((await request(req('DELETE',undefined,'x'.repeat(5000)),null,'app')).status,413);
  maintenance=true;assert.equal((await request(req(),null,'app')).status,503);assert.equal(calls,0);
  maintenance=false;assert.equal((await request(req(),null,'app')).status,202);
  assert.equal((await request(req('GET'),null,'app')).headers.get('cache-control'),'no-store');
});

test('agent detachment preserves peer state, active files and routes through reloads, crash replay and later deployment',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-detach-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id=randomUUID(),peer=randomUUID(),alias=randomUUID(),peerAlias=randomUUID();
  const saved={app:{id,name:'Preserved',repo_url:'https://example.com/org/app',branch:'main',start_cmd:'node app.js',health_path:'/',hostname:'preserved.example.com',port:43121,access_mode:'wan',ip_address:'',ip_port:null},ecosystem:path.join(root,'release.cjs'),commit:'a'.repeat(40)};
  const other={...saved,app:{...saved.app,id:peer,name:'Peer',hostname:'peer.example.com',port:43122}};
  const initial={[id]:saved,[peer]:other},domains={[alias]:{appId:id,hostname:'alias.example.com'},[peerAlias]:{appId:peer,hostname:'peer-alias.example.com'}};
  await agent.atomicJson(path.join(root,'apps.json'),initial);await agent.atomicJson(path.join(root,'domains.json'),domains);
  await fs.writeFile(saved.ecosystem,'untouched release');await fs.writeFile(path.join(root,'Caddyfile'),'untouched proxy');
  const before=await agent.managedCaddyConfig(root,[saved.app,other.app]);
  const job={payload:{action:'detach',id,expiresAt:Date.now()+60000}},tools={pm:()=>{throw Error('Must not control any process')}};
  await agent.atomicJson(path.join(root,'resources.json'),{apps:{[id]:{sleepAfterMinutes:30}}});
  await assert.rejects(agent.infrastructureJob(root,job,tools,()=>{}),/Disable staging sleep/);
  await agent.atomicJson(path.join(root,'resources.json'),{apps:{}});
  const receipt=await agent.infrastructureJob(root,job,tools,()=>{});assert.equal(receipt.detachedAppId,id);assert.equal(receipt.preservedResources,true);
  assert.deepEqual(await agent.readJson(path.join(root,'apps.json')),{[peer]:other});assert.deepEqual(await agent.readJson(path.join(root,'domains.json')),{[peerAlias]:domains[peerAlias]});
  for(const text of ['preserved.example.com','alias.example.com','peer.example.com','peer-alias.example.com'])assert.ok((await agent.managedCaddyConfig(root,[other.app])).includes(text),text);
  assert.equal(await fs.readFile(saved.ecosystem,'utf8'),'untouched release');assert.equal(await fs.readFile(path.join(root,'Caddyfile'),'utf8'),'untouched proxy');
  // Crash after the preservation record, before registry removal: regeneration deduplicates it and retry completes.
  await agent.atomicJson(path.join(root,'apps.json'),initial);await agent.atomicJson(path.join(root,'domains.json'),domains);
  const crashConfig=await agent.managedCaddyConfig(root,[saved.app,other.app]);assert.equal(crashConfig.split('preserved.example.com {').length,before.split('preserved.example.com {').length);
  assert.deepEqual(await agent.infrastructureJob(root,job,tools,()=>{}),receipt);
  await assert.rejects(agent.managedCaddyConfig(root,[{...other.app,hostname:saved.app.hostname}]),/preserved site/);
  await assert.rejects(agent.infrastructureJob(root,{payload:{action:'restart',id,expiresAt:Date.now()+60000}},tools,()=>{}),/removed from Manager/);
  // An attempted deployment cannot claim a retained port, even while its process is stopped.
  const deploy={id:randomUUID(),payload:{...saved.app,id:randomUUID(),repo_url:'https://example.com/org/app',branch:'main',start_cmd:'node app.js',health_path:'/'}};
  await assert.rejects(agent.deploy(root,deploy,{}, {tools:{git:true,caddy:true}},async()=>{},()=>{}),/preserved after removal/);
  const failed=randomUUID();await agent.infrastructureJob(root,{payload:{action:'detach',id:failed,expiresAt:Date.now()+60000}},tools,()=>{});
  assert.ok((await agent.managedCaddyConfig(root,[other.app])).includes('preserved.example.com'));
});

test('PostgreSQL application removal is scoped, reviewed, transactional and waits for authenticated agent preservation', {skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pg=require('pg'),schema='removal_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href});await admin.query(`create schema ${schema}`);
  const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema},public`,max:12}),query=(sql,args)=>pool.query(sql,args);
  t.after(async()=>{await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()});
  await query(await fs.readFile('db/schema.sql','utf8'));
  for(const file of ['007_automation','010_project_cron_jobs','011_backup_schedules','014_project_databases','015_data_services','018_data_service_backups','019_data_migrations'])await query(await fs.readFile('db/migrations/'+file+'.sql','utf8'));
  // Use encryption in this fixture so review responses cannot accidentally contain archived secrets.
  const secret={encryptSecret:s=>'fixture:'+Buffer.from(s).toString('base64'),decryptSecret:s=>Buffer.from(s.slice(8),'base64').toString()};
  const mocks={'@/lib/api':api,'@/lib/db':{db:pool,query},'@/lib/audit':{audit:async()=>{}},'@/lib/git-provider-policy':{},'@/lib/github-connections':{},'@/lib/remote-security-gate-policy':load('lib/remote-security-gate-policy.ts',{}),'@/lib/deployment-cache':{loadAuditExceptions:()=>[]},'@/lib/security-gate-policy':load('lib/security-gate-policy.ts',{}),'@/lib/remote-setup-policy':{},'@/lib/secret-crypto':secret,'@/scripts/manager-agent.cjs':agent};
  const managed=load('lib/managed-servers.ts',mocks);const removal=load('lib/application-removal.ts',{'@/lib/api':api,'@/lib/db':{db:pool,query},'@/lib/managed-servers':managed,'@/lib/secret-crypto':secret});mocks['@/lib/application-removal']=removal;
  const user=(await query("insert into users(email,name,password_hash) values('fixture@example.test','Fixture','unused') returning id")).rows[0].id;
  const server=await managed.addServer({name:'Target',platform:'win32'},user),peer=await managed.addServer({name:'Peer',platform:'win32'},user);
  const makeApp=async(serverId,name,port,production=null)=>(await query("insert into remote_apps(server_id,name,repo_url,start_cmd,port,access_mode,hostname,env_ciphertext,production_id) values($1,$2,'https://example.com/repo','node app.js',$3,'wan',$4,$5,$6) returning id",[serverId,name,port,randomUUID()+'.example.com',secret.encryptSecret('{\"TOKEN\":\"never show me\"}'),production])).rows[0].id;
  const confirm=async(serverId,id)=>{const r=await removal.reviewApplicationRemoval(serverId,id);assert.ok(!JSON.stringify(r).includes('never show me'));return{reviewToken:r.reviewToken,confirmationName:r.application.name,acknowledged:true}};
  const incomplete=await makeApp(server.id,'Incomplete',44001),preserve=await makeApp(peer.id,'Peer app',44001);
  await assert.rejects(removal.reviewApplicationRemoval(peer.id,incomplete),e=>e.status===404);
  const stale=await confirm(server.id,incomplete);await query("update remote_apps set name='Renamed' where id=$1",[incomplete]);await assert.rejects(removal.removeApplication(server.id,incomplete,stale,user),e=>e.status===409);
  await assert.rejects(removal.removeApplication(server.id,incomplete,{...await confirm(server.id,incomplete),acknowledged:false},user),e=>e.status===400);
  await removal.removeApplication(server.id,incomplete,await confirm(server.id,incomplete),user);assert.equal((await query('select 1 from remote_apps where id=$1',[preserve])).rowCount,1);
  const deployed=await makeApp(server.id,'Deployed',44002),staging=await makeApp(server.id,'Staging',44003,deployed);
  await query("update remote_apps set live_commit=$2 where id=$1",[deployed,'b'.repeat(40)]);
  assert.ok((await removal.reviewApplicationRemoval(server.id,deployed)).blockers.some(s=>s.includes('Reconnect')));
  await query("update managed_servers set enrolled_at=now(),last_seen_at=now(),metrics=$2 where id=$1",[server.id,JSON.stringify({capabilities:['remote-console-v1']})]);
  assert.ok((await removal.reviewApplicationRemoval(server.id,deployed)).blockers.some(s=>s.includes('Update the agent')));
  await query('update managed_servers set metrics=$2 where id=$1',[server.id,JSON.stringify({capabilities:['remote-console-v1',removal.APPLICATION_CONTROL_CAPABILITY]})]);
  const pending=await removal.removeApplication(server.id,deployed,await confirm(server.id,deployed),user);assert.ok(pending.jobId);assert.equal((await query('select 1 from remote_apps where id=$1',[deployed])).rowCount,1);
  const claimed=(await managed.claimJob(server.id)).job;assert.equal(claimed.id,pending.jobId);assert.equal(claimed.kind,'infrastructure');
  const report={id:claimed.id,claimToken:claimed.claimToken,status:'success',sequence:1,log:'Preserved',result:{ok:true,detachedAppId:deployed,preservedResources:true}};
  await assert.rejects(managed.reportJob(peer.id,report),e=>e.status===404);
  await assert.rejects(managed.reportJob(server.id,{...report,result:{ok:true,detachedAppId:staging,preservedResources:true}}),e=>e.status===400);
  assert.equal((await query('select status from remote_jobs where id=$1',[claimed.id])).rows[0].status,'running');
  await managed.reportJob(server.id,report);await managed.reportJob(server.id,report); // receipt retry is harmless
  assert.equal((await query('select 1 from remote_apps where id=$1',[deployed])).rowCount,0);
  assert.equal((await query('select production_id from remote_apps where id=$1',[staging])).rows[0].production_id,null);
  assert.equal((await query('select app_id from remote_jobs where id=$1',[claimed.id])).rows[0].app_id,null);
  // Host uses the same review, keeps database credentials encrypted, and never calls filesystem/proxy tools.
  const host=(await query("insert into projects(name,slug,root_path,pm2_name,url) values('Host fixture',$1,$2,'fixture-process','https://host.example.com') returning id",[randomUUID(),path.join(os.tmpdir(),'host-fixture')])).rows[0].id;
  await query("insert into project_databases(project_id,database_name,role_name,password_ciphertext) values($1,$2,$3,'encrypted-password')",[host,randomUUID(),randomUUID()]);
  const body=await confirm(null,host);await assert.rejects(removal.removeApplication(null,host,body,randomUUID()),/foreign key/);assert.equal((await query('select 1 from projects where id=$1',[host])).rowCount,1);
  await removal.removeApplication(null,host,body,user);const archive=(await query('select record_ciphertext from removed_application_records where application_id=$1',[host])).rows[0];assert.equal(JSON.parse(secret.decryptSecret(archive.record_ciphertext)).databases[0].password_ciphertext,'encrypted-password');
});
