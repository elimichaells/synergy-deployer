const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID,randomBytes}=require('node:crypto');
const agent=require('../scripts/manager-agent.cjs');
const policy=require('../lib/remote-setup-policy.ts');
const load=require('./server-module.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}

test('environment planning includes staging without an implicit production record',()=>{
  assert.deepEqual(policy.remoteEnvironmentPlan('staging','qa','develop'),[{environment:'staging',branch:'qa'}]);
  assert.deepEqual(policy.remoteEnvironmentPlan('production','main','develop'),[{environment:'production',branch:'main'}]);
  assert.deepEqual(policy.remoteEnvironmentPlan('production-staging','main','develop'),[{environment:'production',branch:'main'},{environment:'staging',branch:'develop'}]);
  assert.throws(()=>policy.remoteEnvironmentPlan('anything','main','main'));
});

test('framework detection reads manifests without executing repository code, on Windows and Linux',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-framework-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const platform of ['win32','linux'])for(const framework of ['next','angular','node','go','laravel']){
    const dir=path.join(root,platform+'-'+framework);await fs.mkdir(dir);
    if(framework==='go')await fs.writeFile(path.join(dir,'go.mod'),'module example.test/app\n');
    else if(framework==='laravel')await fs.writeFile(path.join(dir,'composer.json'),JSON.stringify({require:{'laravel/framework':'^12'}}));
    else {await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({dependencies:framework==='next'?{next:'16'}:framework==='angular'?{'@angular/core':'20'}:{},scripts:{build:'throw new Error("never execute")',start:'never execute'}}));await fs.writeFile(path.join(dir,'package-lock.json'),'{}');}
    const result=await agent.detectFramework(dir,platform,4567);assert.equal(result.framework,framework);
    if(framework==='go'){assert.match(result.commands.build_cmd,platform==='win32'?/app\.exe/:/-o app /);assert.equal(result.commands.start_cmd,platform==='win32'?'.\\app.exe':'./app');}
    if(framework==='laravel')assert.match(result.commands.start_cmd,/--port=4567/);
    if(framework==='angular')assert.equal(result.commands.start_cmd,'@manager/static');
    if(result.packageManager)assert.equal(result.commands.install_cmd,'npm ci --include=dev');
  }
  const linked=path.join(root,'linked');await fs.mkdir(linked);await fs.symlink(path.join(root,'win32-next','package.json'),path.join(linked,'package.json'),'file');
  await assert.rejects(agent.detectFramework(linked),/symlink/);
  const yarn=path.join(root,'yarn');await fs.mkdir(yarn);await fs.writeFile(path.join(yarn,'package.json'),'{}');await fs.writeFile(path.join(yarn,'yarn.lock'),'# yarn lockfile v1');
  assert.equal((await agent.detectFramework(yarn)).commands.install_cmd,'yarn install --frozen-lockfile --production=false');
  await fs.writeFile(path.join(yarn,'yarn.lock'),'__metadata:\n  version: 8');
  assert.equal((await agent.detectFramework(yarn)).commands.install_cmd,'yarn install --immutable');
  await fs.writeFile(path.join(yarn,'pnpm-lock.yaml'),'lockfileVersion: 9');
  assert.equal((await agent.detectFramework(yarn)).commands.install_cmd,'pnpm install --frozen-lockfile --prod=false');
});

test('database validation rejects injection and preserves credential boundaries',()=>{
  const input={mode:'existing',provider:'postgresql',host:'127.0.0.1',port:5432,database:'example',username:'app_user',password:"a'\\b@secret",tls:true};
  const env=agent.databaseEnvironment(input);assert.match(env.DATABASE_URL,/sslmode=verify-full/);assert.equal(env.DB_PASSWORD,input.password);
  for(const changes of [{database:'x;DROP DATABASE postgres'},{username:'x\n\\gexec'},{host:'--host=evil'},{password:'one\ntwo'},{port:0}])assert.throws(()=>agent.validateDatabase({...input,...changes}));
  assert.throws(()=>agent.validateDatabase({...input,mode:'create',provider:'mysql',host:'db.example.edu',adminUsername:'root',adminPassword:'secret'}),/loopback/);
  assert.equal(agent.redact(`password ${input.password} ${encodeURIComponent(input.password)}`,agent.jobSecrets({database:input})), 'password [redacted] [redacted]');
});

test('MySQL provisioning sends passwords through private files and stdin, never command arguments',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-db-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const database={mode:'create',provider:'mysql',host:'127.0.0.1',port:3306,database:'app_fixture',username:'app_fixture',password:"test'password",adminUsername:'root',adminPassword:'admin-secret',tls:false};
  const calls=[];
  await agent.setupDatabase(root,{id:randomUUID(),payload:{id:randomUUID(),database}},()=>{},{run:async(file,args,options)=>{
    calls.push({file,args,input:options.input});assert.ok(!args.join(' ').includes('secret'));assert.ok(!args.join(' ').includes('password'));
    const filename=args[0].slice('--defaults-extra-file='.length);assert.ok((await fs.readFile(filename,'utf8')).includes('[client]'));
    return options.input.includes('SELECT 1;')?'1':'';
  }});
  assert.equal(calls.length,3);assert.match(calls[1].input,/IDENTIFIED BY 'test''password'/);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('review requires a tested database, actual prerequisites, a domain and explicit environment review',()=>{
  const app={hostname:'app.example.edu',start_cmd:'npm start',env_names:[],project_type:'next',inspection:{commit:'a'.repeat(40),tools:{node:'24',git:'2',pm2:'6',caddy:'2',npm:'11'},packageManager:'npm'},setup_decisions:{database:'configured',environment:'reviewed',domain:'configured'},database_config:{status:'ready'}};
  assert.ok(policy.remoteSetupChecks(app).every(x=>x.status==='pass'));
  for(const patch of [{inspection:null},{database_config:{status:'failed'}},{hostname:'draft.invalid'},{setup_decisions:{}},{project_type:'unsupported'}])assert.ok(policy.remoteSetupChecks({...app,...patch}).some(x=>x.status==='fail'));
});

test('Angular static hosting serves SPA routes and refuses source, hidden files and symlink escapes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-static-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=path.join(root,'dist','site','browser');await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'index.html'),'<h1>Built app</h1>');await fs.writeFile(path.join(output,'app.js'),'console.log("static")');await fs.writeFile(path.join(root,'package.json'),'private source');
  assert.equal(await agent.findStaticRoot(root),output);
  const server=agent.serveStatic(output,0);await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(origin+'/dashboard')).text(),/Built app/);
  assert.match((await fetch(origin+'/app.js')).headers.get('content-type'),/javascript/);
  for(const value of ['/package.json','/.env','/%2e%2e%5cpackage.json'])assert.equal((await fetch(origin+value)).status,404);
  await fs.symlink(path.join(root,'package.json'),path.join(output,'linked.json'),'file');
  assert.equal((await fetch(origin+'/linked.json')).status,404);await assert.rejects(agent.findStaticRoot(root),/symlinks/);
});

test('guided setup routes enforce administrator mutations, protected environment reads and same origin',async()=>{
  let role='viewer',calls=0;
  const rbac=load('lib/rbac.ts',{'./api':{ApiError}}),bodyTools=load('lib/request-body.ts',{'@/lib/api':{ApiError}});
  const route=load('app/api/servers/[[...path]]/route.ts',{
    '@/lib/remote-agent-updates':{},
    '@/lib/auth':{getSessionFromCookie:async()=>role?{id:'fixture-user',role}:null},'@/lib/rbac':rbac,
    '@/lib/api':{ApiError,jsonError:error=>Response.json({error:error.message},{status:error.status||500})},'@/lib/request-body':bodyTools,
    '@/lib/managed-servers':{},'@/lib/remote-app-setup':{remoteSetup:async()=>({app:{env_names:[]}}),remoteSetupEnvironment:async()=>{calls++;return{environment:{}};},importRemoteApp:async()=>{calls++;return{};},changeRemoteSetup:async()=>{calls++;return{};}},
  });
  const context=path=>({params:Promise.resolve({path})});
  const request=(origin='https://manager')=>new Request('https://manager/api/servers/id/apps/import',{method:'POST',headers:{host:'manager',origin,'content-type':'application/json'},body:JSON.stringify({action:'database'})});
  for(const value of [null,'viewer','operator']){role=value;assert.equal((await route.POST(request(),context(['id','apps','import']))).status,value?403:401);assert.equal((await route.GET(new Request('https://manager'),context(['id','apps','app','environment']))).status,value?403:401);}
  role='admin';assert.equal((await route.POST(request('https://attacker.example'),context(['id','apps','app','setup']))).status,403);assert.equal(calls,0);
  assert.equal((await route.POST(request(),context(['id','apps','import']))).status,201);assert.equal(calls,1);
});

test('real database: import modes, setup reports, per-server isolation, provisioning and deployment gates',{skip:!process.env.MANAGER_GUIDED_PG_LAB},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55439');assert.match(url.pathname,/^\/manager_remote_test_/);
  const {Pool}=require('pg');const pool=new Pool({connectionString:url.href,max:10});t.after(()=>pool.end());
  const query=(sql,args)=>pool.query(sql,args);
  await query('create extension if not exists pgcrypto;create table if not exists users(id uuid primary key);create table if not exists github_connections(id uuid primary key)');
  const userId=randomUUID();await query('insert into users values($1)',[userId]);
  process.env.MANAGER_ENCRYPTION_KEY='isolated-guided-setup-test-key';
  const crypto=load('lib/secret-crypto.ts',{});
  const mocks={'@/lib/db':{db:pool,query},'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':crypto,'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':agent,'@/lib/remote-setup-policy':policy};
  const managed=load('lib/managed-servers.ts',mocks);
  const setup=load('lib/remote-app-setup.ts',{...mocks,'@/lib/managed-servers':managed,'@/lib/project-setup-policy':require('../lib/project-setup-policy.ts')});
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-guided-db-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const server=await managed.addServer({name:'Guided test',platform:'win32'},userId), other=await managed.addServer({name:'Other server',platform:'linux'},userId);
  await managed.enroll({protocol:1,serverId:server.id,platform:'win32',agentToken:randomBytes(32).toString('base64url'),enrollmentToken:server.enrollmentToken});
  const body={name:'Library',repo_url:'https://github.com/example/library',branch:'main',stagingBranch:'develop',environmentMode:'staging'};
  await assert.rejects(setup.importRemoteApp(server.id,body,userId),/agent 1.1/);
  await query('update managed_servers set metrics=$2::jsonb where id=$1',[server.id,JSON.stringify({capabilities:['guided-setup-v1']})]);
  const imported=await setup.importRemoteApp(server.id,body,userId);assert.equal(imported.apps.length,1);assert.equal(imported.apps[0].environment,'staging');
  let snapshot=await setup.remoteSetup(server.id,imported.id);assert.equal(snapshot.app.production_id,null);
  await assert.rejects(setup.remoteSetup(other.id,imported.id),/not found/);
  await assert.rejects(managed.queueRemoteDeploy(server.id,imported.id,userId),/Complete guided/);
  const claim=(await managed.claimJob(server.id)).job;assert.equal(claim.kind,'inspect');
  // Old agents cannot claim or replay a setup operation, even after a service downgrade.
  await query("update managed_servers set metrics='{}'::jsonb where id=$1",[server.id]);assert.equal((await managed.claimJob(server.id)).job,null);
  await query('update managed_servers set metrics=$2::jsonb where id=$1',[server.id,JSON.stringify({capabilities:['guided-setup-v1']})]);
  const inspection={framework:'next',commit:'a'.repeat(40),commands:{install_cmd:'npm ci',build_cmd:'npm run build',start_cmd:'npm start'},tools:{node:'24',git:'2',pm2:'6',caddy:'2',npm:'11'},packageManager:'npm'};
  await managed.reportJob(server.id,{id:claim.id,claimToken:claim.claimToken,status:'success',sequence:1,log:'Inspected',commitSha:inspection.commit,result:inspection});
  assert.equal((await managed.serverDetail(server.id)).apps.find(x=>x.id===imported.id).live_commit,null);
  assert.equal((await managed.serverDetail(server.id)).jobs.length,0);
  snapshot=await setup.remoteSetup(server.id,imported.id);assert.equal(snapshot.app.project_type,'next');assert.equal(snapshot.app.setup_step,'runtime');
  await setup.changeRemoteSetup(server.id,imported.id,{action:'save',step:'database',project_type:'next'},userId);
  await setup.changeRemoteSetup(server.id,imported.id,{action:'database',mode:'create',provider:'postgresql',host:'127.0.0.1',port:55439,adminUsername:'manager_setup_test',adminPassword:'isolated-setup-fixture'},userId);
  const databaseJob=(await managed.claimJob(server.id)).job;assert.equal(databaseJob.kind,'database');
  assert.ok(!(JSON.stringify(await setup.remoteSetup(server.id,imported.id))).includes('isolated-setup-fixture'));
  const result=await agent.setupDatabase(root,databaseJob,()=>{});
  await managed.reportJob(server.id,{id:databaseJob.id,claimToken:databaseJob.claimToken,status:'success',sequence:1,log:'created '+databaseJob.payload.database.password,result});
  snapshot=await setup.remoteSetup(server.id,imported.id);assert.equal(snapshot.app.database_config.status,'ready');assert.ok(!JSON.stringify(snapshot).includes(databaseJob.payload.database.password));
  const appDatabase=databaseJob.payload.database;
  await assert.rejects(agent.setupDatabase(root,{...databaseJob,id:randomUUID(),payload:{...databaseJob.payload,database:{...appDatabase,mode:'existing',password:'incorrect-password'}}},()=>{}),/authentication failed/);
  await assert.rejects(agent.setupDatabase(root,{...databaseJob,id:randomUUID()},()=>{}),/already exists/);
  await setup.changeRemoteSetup(server.id,imported.id,{action:'save',step:'domain',environment:{CUSTOM:'staging-secret'},environmentReviewed:true},userId);
  await setup.changeRemoteSetup(server.id,imported.id,{action:'save',step:'review',hostname:`staging-${imported.id}.example.edu`,domainConfigured:true},userId);
  await setup.changeRemoteSetup(server.id,imported.id,{action:'validate'},userId);
  const validation=(await managed.claimJob(server.id)).job;
  await agent.validateSetup(root,validation,{tools:{node:'24',git:'2',pm2:'6',caddy:'2'}},{run:async(file,args,options)=>file==='psql'?agent.run(file,args,options):'fixture-version',checkPort:async()=>{}});
  await managed.reportJob(server.id,{id:validation.id,claimToken:validation.claimToken,status:'success',sequence:1,log:'checked',result:{ok:true}});
  await managed.queueRemoteDeploy(server.id,imported.id,userId);const deployment=(await managed.claimJob(server.id)).job;
  assert.equal(deployment.kind,'deploy');assert.equal(deployment.payload.environment.CUSTOM,'staging-secret');assert.equal(deployment.payload.environment.DB_PASSWORD,appDatabase.password);assert.equal(deployment.payload.database,undefined);assert.ok(!JSON.stringify(deployment).includes('isolated-setup-fixture'));
  await managed.reportJob(server.id,{id:deployment.id,claimToken:deployment.claimToken,status:'failed',sequence:1,log:'Test did not execute a deployment'});
  await setup.changeRemoteSetup(server.id,imported.id,{action:'save',step:'runtime',port:4501},userId);await assert.rejects(managed.queueRemoteDeploy(server.id,imported.id,userId),/Complete guided/);
  const both=await setup.importRemoteApp(server.id,{...body,environmentMode:'production-staging'},userId);assert.equal(both.apps.length,2);
  const rows=(await query('select * from remote_apps where id=any($1::uuid[])',[both.apps.map(x=>x.id)])).rows;
  assert.equal(new Set(rows.map(x=>x.port)).size,2);assert.equal(new Set(rows.map(x=>x.hostname)).size,2);assert.equal(rows.find(x=>x.environment_name==='staging').production_id,both.id);
  const production=await setup.importRemoteApp(server.id,{...body,environmentMode:'production'},userId);assert.equal(production.apps.length,1);assert.equal(production.apps[0].environment,'production');
  const before=(await query('select count(*) from remote_apps where server_id=$1',[server.id])).rows[0].count;
  await assert.rejects(setup.importRemoteApp(server.id,{...body,environmentMode:'production-staging',stagingBranch:'--bad'},userId));
  assert.equal((await query('select count(*) from remote_apps where server_id=$1',[server.id])).rows[0].count,before);
});
