const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const agent=require('../scripts/manager-agent.cjs');
const policy=require('../scripts/remote-service-policy.cjs');
const load=require('./server-module.cjs');
class ApiError extends Error {constructor(message,status){super(message);this.status=status}}

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-console-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root}
const job=(command,extra={})=>({kind:'console',payload:{command,expiresAt:Date.now()+60000,...extra}});
test('console executes in its private directory and redacts environment secrets',async t=>{
  const root=await fixture(t);let log='';const password='private-console-password-123';
  const result=await agent.consoleJob(root,job(process.platform==='win32'?'Write-Output $env:DB_PASSWORD':'printf "%s" "$DB_PASSWORD"',{environment:{DB_PASSWORD:password}}),{},s=>log+=s);
  assert.equal(result.ok,true);assert.equal(result.cwd,await fs.realpath(path.join(root,'console')));assert.match(log,/\[redacted\]/);assert.ok(!log.includes(password));
});
test('console rejects expired requests, multiline commands and escaping working directories',async t=>{
  const root=await fixture(t);
  await assert.rejects(agent.consoleJob(root,job('echo unsafe',{expiresAt:1}),{},()=>{}),/expired/);
  await assert.rejects(agent.consoleJob(root,job('echo first\necho second'),{},()=>{}),/one command/);
  await assert.rejects(agent.consoleJob(root,job('echo unsafe',{cwd:'..'}),{},()=>{}),/stay inside/);
  await fs.symlink(os.tmpdir(),path.join(root,'console','outside'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(agent.consoleJob(root,job('echo unsafe',{cwd:'outside'}),{},()=>{}),/stay inside/);
  await fs.unlink(path.join(root,'console','outside'));
});
test('stopping a console terminates its child process tree', {timeout:15000},async t=>{
  const extensions=process.env.PATHEXT;delete process.env.PATHEXT;t.after(()=>{if(extensions!==undefined)process.env.PATHEXT=extensions});
  const root=await fixture(t),controller=new AbortController();
  const marker=path.join(root,'child.txt'),child=path.join(root,'child.cjs');
  await fs.writeFile(child,`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`);
  const cmd=process.platform==='win32'?`& '${process.execPath.replace(/'/g,"''")}' '${child.replace(/'/g,"''")}'`:`'${process.execPath}' '${child}'`;
  const running=agent.consoleJob(root,job(cmd),{},()=>{},controller.signal);const rejected=assert.rejects(running,/cancelled/);
  let pid;for(let i=0;i<100;i++){try{pid=Number(await fs.readFile(marker,'utf8'));break}catch{}await new Promise(r=>setTimeout(r,50))}
  assert.ok(pid);controller.abort();await rejected;
  assert.throws(()=>process.kill(pid,0));
});
test('application logs are bounded and restricted to that application’s private PM2 files',async t=>{
  const root=await fixture(t),id=randomUUID(),release=path.join(root,'releases',id,'release-1');
  await fs.mkdir(release,{recursive:true});await fs.mkdir(path.join(root,'pm2','logs'),{recursive:true});
  await fs.writeFile(path.join(release,'launch.json'),JSON.stringify({cwd:release}));await fs.writeFile(path.join(root,'apps.json'),JSON.stringify({[id]:{ecosystem:path.join(release,'ecosystem.cjs')}}));
  const out=path.join(root,'pm2','logs','out.log'),err=path.join(root,'pm2','logs','err.log');await fs.writeFile(out,'x'.repeat(100000)+'secret-db-pass');await fs.writeFile(err,'error line');
  const pm=async()=>JSON.stringify([{name:'manager-remote-'+id,pm2_env:{pm_out_log_path:out,pm_err_log_path:err}}]);let log='';
  await agent.consoleJob(root,{kind:'logs',payload:{id,expiresAt:Date.now()+60000,environment:{DB_PASSWORD:'secret-db-pass'}}},{pm},s=>log+=s);
  assert.ok(log.length<49000);assert.match(log,/error line/);assert.ok(!log.includes('secret-db-pass'));
  await assert.rejects(agent.consoleJob(root,{kind:'logs',payload:{id,expiresAt:Date.now()+60000}},{pm:async()=>JSON.stringify([{name:'manager-remote-'+id,pm2_env:{pm_out_log_path:path.join(root,'agent.json')}}])},()=>{}),/outside/);
});

test('service planning reuses verified custom paths and protects existing engines and occupied ports',()=>{
  for(const platform of ['win32','linux']){
    const executable=platform==='win32'?'D:\\custom\\PostgreSQL\\bin\\psql.exe':'/opt/postgresql/bin/psql';
    const inventory={platform,portsKnown:true,ports:[],services:[],tools:{psql:[{path:executable,compatible:true}]}};
    const reuse=policy.servicePlan({service:'postgresql',mode:'reuse',path:executable},platform);policy.verifyServicePlan(reuse,inventory);
    assert.throws(()=>policy.verifyServicePlan({...reuse,path:executable+'wrong'},inventory),/verify/);
    const install=policy.servicePlan({service:'postgresql',mode:'install'},platform);policy.verifyServicePlan(install,inventory); // A client alone is not a database engine.
    assert.throws(()=>policy.verifyServicePlan(install,{...inventory,services:[{name:'postgresql-18',executable:''}]}),/existing installation/);
    assert.throws(()=>policy.verifyServicePlan(install,{...inventory,ports:[5432]}),/already in use/);
    assert.throws(()=>policy.verifyServicePlan(install,{...inventory,portsKnown:false}),/Inspect/);
  }
  for(const value of ['C:\\','\\\\server\\share\\x','relative','C:\\data\nother'])assert.throws(()=>policy.servicePlan({service:'node',mode:'install',dataRoot:value},'win32'));
});

test('project runtime versions remain separate from the default and reject missing or cross-server selections',async t=>{
  const root=await fixture(t),exe=path.join(root,process.platform==='win32'?'node.exe':'node');await fs.writeFile(exe,'fixture');
  await fs.writeFile(path.join(root,'runtime-versions.json'),JSON.stringify({node:{'22.23.4':exe,'24.0.0':exe+'.missing'}}));
  assert.deepEqual((await agent.installedRuntimeVersions(root)).node,['22.23.4']);
  const env=await agent.runtimeEnvironment(root,{node:'22.23.4'});assert.equal(env.MANAGER_NODE_VERSION,'22.23.4');assert.equal(env.PATH.split(path.delimiter)[0],root);
  await assert.rejects(agent.runtimeEnvironment(root,{node:'24.0.0'}),/not installed/);assert.deepEqual(await agent.runtimeEnvironment(root,{}),{});
  for(const pins of [{node:'../../outside'},{caddy:'2.8.4'},{node:null}])assert.throws(()=>agent.validateRuntimeVersions(pins));
  assert.throws(()=>agent.validateRuntimeSelection({node:'22.23.4'},{capabilities:[]}),/Update/);
  assert.throws(()=>agent.validateRuntimeSelection({node:'22.23.4'},{capabilities:[agent.RUNTIME_CAPABILITY],runtimeVersions:{node:[]}}),/this server/);
  assert.deepEqual(agent.validateRuntimeSelection({node:'22.23.4'},{capabilities:[agent.RUNTIME_CAPABILITY],runtimeVersions:{node:['22.23.4']}}),{node:'22.23.4'});
  const plan=policy.servicePlan({service:'node',mode:'install-version',version:'22.23.4'},'win32');policy.verifyServicePlan(plan,{portsKnown:true,ports:[80,443],tools:{node:[{compatible:true}]},services:[]});
  assert.throws(()=>policy.servicePlan({service:'postgresql',mode:'install-version',version:'18.6.0'},'win32'));
});

function consoleModule(overrides={}){
  const calls=[],server={enabled:true,enrolled_at:'now',last_seen_at:new Date().toISOString(),metrics:{capabilities:[agent.CONSOLE_CAPABILITY]}},id=randomUUID();
  const query=async(sql,args)=>{calls.push({sql,args});if(sql.includes('pg_try_advisory'))return {rows:[{ok:!overrides.setupBusy}]};if(sql.includes('select 1 from remote_agent_updates'))return {rows:[],rowCount:overrides.updateBusy?1:0};if(sql.includes('select * from managed_servers'))return {rows:[{...server,...overrides.server}],rowCount:1};if(sql.includes('select 1 from remote_service_operations'))return {rows:[],rowCount:overrides.busy?1:0};if(sql.includes('insert into remote_jobs'))return {rows:[{id}],rowCount:1};return {rows:[],rowCount:0}};
  const mod=load('lib/remote-console.ts',{'./api':{ApiError},'./audit':{audit:async()=>{}},'./db':{query,db:{connect:async()=>({query,release(){}})}},'./managed-servers':{ensureManagedServers:async()=>{},uuid:v=>v},'./secret-crypto':{encryptSecret:x=>x,decryptSecret:x=>x},'./project-console':{validateConsoleCommand:x=>typeof x==='string'&&x.trim()?null:'Enter a command'},'@/scripts/manager-agent.cjs':agent});return {mod,calls,id};
}
test('console admission requires a connected capable server and waits for service operations',async()=>{
  for(const overrides of [{server:{enabled:false}},{server:{last_seen_at:'2000-01-01'}},{server:{metrics:{capabilities:[]}}},{busy:true},{setupBusy:true},{updateBusy:true}]){
    const {mod,calls}=consoleModule(overrides);await assert.rejects(mod.queueRemoteConsole(randomUUID(),null,{action:'run',command:'echo test'},randomUUID()));assert.ok(!calls.some(x=>x.sql.includes('insert into')));
  }
  const {mod,calls,id}=consoleModule();assert.equal((await mod.queueRemoteConsole(randomUUID(),null,{action:'run',command:'echo test'},randomUUID())).id,id);
  const payload=JSON.parse(calls.find(x=>x.sql.includes('insert into')).args[4]);assert.equal(payload.requiredCapability,agent.CONSOLE_CAPABILITY);assert.ok(payload.expiresAt>Date.now()&&payload.expiresAt<Date.now()+61000);
});

test('real PostgreSQL serializes console and service work and preserves cancellation', {skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pool=new (require('pg').Pool)({connectionString:url.href});t.after(()=>pool.end());const query=(s,p)=>pool.query(s,p);
  await query('create extension if not exists pgcrypto;create table if not exists users(id uuid primary key);create table if not exists github_connections(id uuid primary key)');
  process.env.MANAGER_ENCRYPTION_KEY='isolated-console-integration-key';const secret=load('lib/secret-crypto.ts',{});
  const managed=load('lib/managed-servers.ts',{'@/lib/db':{db:pool,query},'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':secret,'@/lib/github-connections':{},'@/lib/git-provider-policy':{},'@/scripts/manager-agent.cjs':agent,'@/lib/remote-security-gate-policy':load('lib/remote-security-gate-policy.ts',{}),'@/lib/deployment-cache':{loadAuditExceptions:()=>[]},'@/lib/security-gate-policy':load('lib/security-gate-policy.ts',{}),'@/lib/remote-setup-policy':require('../lib/remote-setup-policy.ts')});
  const user=randomUUID();await query('insert into users values($1)',[user]);const server=await managed.addServer({name:'Console fixture',platform:'win32'},user);
  await managed.enroll({protocol:1,platform:'win32',serverId:server.id,enrollmentToken:server.enrollmentToken,agentToken:require('crypto').randomBytes(32).toString('base64url')});
  await query('update managed_servers set last_seen_at=now(),metrics=$2 where id=$1',[server.id,JSON.stringify({capabilities:[agent.CONSOLE_CAPABILITY]})]);
  const mod=load('lib/remote-console.ts',{'./api':{ApiError},'./audit':{audit:async()=>{}},'./db':{db:pool,query},'./managed-servers':managed,'./secret-crypto':secret,'./project-console':{validateConsoleCommand:()=>null},'@/scripts/manager-agent.cjs':agent});
  const queued=await Promise.allSettled([mod.queueRemoteConsole(server.id,null,{action:'run',command:'Get-Date'},user),mod.queueRemoteConsole(server.id,null,{action:'run',command:'Get-Date'},user)]);
  assert.equal(queued.filter(x=>x.status==='fulfilled').length,1);const {job}=await managed.claimJob(server.id);assert.equal(job.kind,'console');
  await mod.cancelRemoteConsole(server.id,job.id,user);const report=await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'running',sequence:1,log:'working'});assert.equal(report.cancelRequested,true);
  await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'failed',sequence:2,log:'cancelled'});
  const record=(await query('select * from remote_jobs where id=$1',[job.id])).rows[0];assert.equal(record.status,'cancelled');assert.equal(record.payload_ciphertext,null);
  const operation=randomUUID();await query("insert into remote_service_operations(id,server_id,user_id,service_id,status,plan) values($1,$2,$3,'postgresql','running','{}')",[operation,server.id,user]);
  assert.equal((await managed.claimJob(server.id)).paused,true);await assert.rejects(mod.queueRemoteConsole(server.id,null,{action:'run',command:'Get-Date'},user),/service operation/);
  await query("update remote_service_operations set status='success' where id=$1",[operation]);const next=await mod.queueRemoteConsole(server.id,null,{action:'run',command:'Get-Date'},user);assert.ok(next.id);
  await mod.cancelRemoteConsole(server.id,next.id,user);assert.equal((await managed.claimJob(server.id)).job,null);
  await query('update managed_servers set metrics=$2 where id=$1',[server.id,JSON.stringify({capabilities:[agent.CONSOLE_CAPABILITY,agent.RUNTIME_CAPABILITY,agent.APPLICATION_CONTROL_CAPABILITY],runtimeVersions:{node:['22.23.4']}})]);
  const appConfig={name:'Pinned runtime fixture',repo_url:'https://github.com/example/test',branch:'main',start_cmd:'node app.cjs',port:45001,access_mode:'lan',hostname:randomUUID()+'.example.test',runtime_versions:{node:'22.23.4'}};
  const app=await managed.saveRemoteApp(server.id,null,appConfig,user);assert.deepEqual((await query('select runtime_versions from remote_apps where id=$1',[app.id])).rows[0].runtime_versions,{node:'22.23.4'});
  await assert.rejects(managed.saveRemoteApp(server.id,app.id,{...appConfig,runtime_versions:{node:'24.0.0'}},user),/this server/);
  const deployment=await managed.queueRemoteDeploy(server.id,app.id,user);const pinned=(await managed.claimJob(server.id)).job;assert.equal(pinned.payload.requiredCapability,agent.APPLICATION_CONTROL_CAPABILITY);assert.equal(pinned.payload.runtime_versions.node,'22.23.4');
  await managed.reportJob(server.id,{id:deployment.id,claimToken:pinned.claimToken,status:'failed',sequence:1,log:'End of isolated queue fixture'});
});


test('tool selection reloads keep PATH bounded and remove replaced directories',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-path-refresh-'));
  const key=Object.keys(process.env).find(k=>k.toLowerCase()==='path')||'PATH',before=process.env[key];
  t.after(async()=>{process.env[key]=before;await fs.rm(root,{recursive:true,force:true})});
  await fs.mkdir(path.join(root,'first'));await fs.mkdir(path.join(root,'second'));
  const first=path.join(root,'first','node.exe'),second=path.join(root,'second','node.exe');
  await fs.writeFile(first,'fixture',{mode:0o700});await fs.writeFile(second,'fixture',{mode:0o700});
  await fs.writeFile(path.join(root,'tool-paths.json'),JSON.stringify({node:first}));
  await agent.loadToolPaths(root);const initial=process.env[key];
  for(let i=0;i<50;i++)await agent.loadToolPaths(root);
  assert.equal(process.env[key],initial);
  await fs.writeFile(path.join(root,'tool-paths.json'),JSON.stringify({node:second}));await agent.loadToolPaths(root);
  assert.equal(process.env[key].split(path.delimiter)[0],path.dirname(second));
  assert.ok(!process.env[key].split(path.delimiter).includes(path.dirname(first)));
});
