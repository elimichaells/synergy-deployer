const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const agent=require('../scripts/manager-agent.cjs'),resources=require('../scripts/manager-agent-resources.cjs'),load=require('./server-module.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
const h={readJson:agent.readJson,atomicJson:agent.atomicJson,contained:agent.contained,run:agent.run,redact:agent.redact,baseEnv:()=>({...process.env}),processList:async pm=>JSON.parse(await pm(['jlist'])),healthy:async()=>{}};
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'manager-resources-test-')),root=path.join(base,'agent');await fs.mkdir(root);t.after(async()=>{await resources.stop(root);assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-resources-test-'));await fs.rm(base,{recursive:true,force:true});});return{root,base};}
test('wire agent bundle is self contained and carries resource capability',async()=>{
  const source=await require('../scripts/agent-bundle.cjs').agentBundle();assert.doesNotMatch(source,/require\('\.\/manager-agent-resources/);const module={exports:{}};vm.runInNewContext(source,{require,module,process,Buffer,console,setTimeout,setInterval,clearTimeout,clearInterval,URL,fetch,AbortSignal});assert.equal(module.exports.AGENT_VERSION,'1.7.0');assert.ok(module.exports.sanitizeMetrics({...metrics(),capabilities:[resources.CAPABILITY]}).capabilities.includes(resources.CAPABILITY));
});
function metrics(){return{platform:'win32',hostname:'test',version:'1.7.0',cpuPercent:1,memoryTotal:8*1024**3,memoryFree:4*1024**3,diskTotal:100*1024**3,diskFree:50*1024**3,uptime:100,tools:{},apps:[]};}
test('real operating-system memory collector reports bounded process usage without commands or environment',{timeout:30000},async t=>{
  const {root}=await fixture(t),sample=await resources.telemetry(root,{},[],h);assert.equal(sample.error,null);assert.ok(sample.processes.length>0);assert.ok(sample.processes.some(p=>p.privateBytes>0));assert.ok(sample.processes.every(p=>!('commandLine' in p)&&!('env' in p)));if(process.platform==='win32')assert.ok(sample.commitLimitMb>0);
});
test('telemetry strips secrets, commands and unrecognized fields and bounds process counts',()=>{
  const clean=resources.sanitize({at:new Date().toISOString(),environment:{PASSWORD:'secret'},processes:Array.from({length:4005},(_,i)=>({pid:i,ppid:1,name:'node',privateBytes:10,workingBytes:15,commandLine:'password=secret'})),apps:[{id:randomUUID(),env:{PASSWORD:'secret'},cwd:'C:\\apps',method:'invalid'}]});assert.equal(clean.processes.length,4000);assert.doesNotMatch(JSON.stringify(clean),/secret|password|commandLine/i);assert.equal(clean.apps[0].method,'runner');
  assert.ok(agent.jobSecrets({resource:{connection:{password:'database-secret'},connections:[{password:'another-secret'}]}}).includes('database-secret'));
});
test('disk cleanup retains current, recent, unknown, pinned and referenced releases and rejects changed reviews',async t=>{
  const {root}=await fixture(t),id=randomUUID(),jobs=Array.from({length:9},()=>randomUUID()),now=Date.now(),rows=[];
  for(let i=0;i<jobs.length;i++){const dir=path.join(root,'releases',id,jobs[i]);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'payload'),'owned fixture');await fs.mkdir(path.join(root,'release-state',jobs[i]),{recursive:true});await fs.writeFile(path.join(root,'release-state',jobs[i],'launch.json'),'{}');if(i!==6)rows.push({id:jobs[i],app_id:id,status:i<5?'success':'failed',finished_at:new Date(now-(i<3?i+10:20)*86400000).toISOString()});}
  const current=path.join(root,'release-state',jobs[4],'ecosystem.config.js');await h.atomicJson(path.join(path.dirname(current),'launch.json'),{cwd:path.join(root,'releases',id,jobs[4])});await h.atomicJson(path.join(root,'apps.json'),{[id]:{ecosystem:current}});
  await fs.writeFile(path.join(root,'releases',id,jobs[5],'.manager-pin'),'keep');
  const workerPath=path.join(root,'releases',id,jobs[7]);await h.atomicJson(path.join(root,'workers.json'),{[randomUUID()]:{workingDirectory:workerPath}});
  const input={action:'disk',mode:'scan',apps:[{id,name:'Fixture'}],releases:rows},tools={pm:async()=> '[]'};
  const scan=await resources.disk(root,input,tools,h),entries=scan.report.projects[0].entries;
  assert.deepEqual(entries.filter(e=>e.eligible).map(e=>e.name).sort(),[jobs[3],jobs[8]].sort());
  await assert.rejects(resources.disk(root,{...input,mode:'clean',reviewToken:'wrong'},tools,h),/Scan storage/);
  await fs.writeFile(path.join(root,'releases',id,jobs[3],'.manager-pin'),'pin after review');
  const clean=await resources.disk(root,{...input,mode:'clean',reviewToken:scan.reviewToken},tools,h);assert.deepEqual(clean.report.removed.map(e=>e.path),[path.join(root,'releases',id,jobs[8])]);assert.equal(await fs.stat(path.join(root,'releases',id,jobs[3])).then(s=>s.isDirectory()),true);await assert.rejects(fs.stat(path.join(root,'release-state',jobs[8])),{code:'ENOENT'});
});
test('cleanup never follows a junction or deletes data outside the dedicated agent root',async t=>{
  const {root,base}=await fixture(t),id=randomUUID(),job=randomUUID(),foreign=path.join(base,'existing-site');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'keep'),'existing data');const parent=path.join(root,'releases',id);await fs.mkdir(parent,{recursive:true});await fs.symlink(foreign,path.join(parent,job),process.platform==='win32'?'junction':'dir');
  const input={mode:'clean',automatic:true,apps:[{id,name:'Fixture'}],releases:[{id:job,app_id:id,status:'failed',finished_at:new Date(0).toISOString()}]},result=await resources.disk(root,input,{pm:async()=> '[]'},h);assert.equal(result.report.removed.length,0);assert.equal(await fs.readFile(path.join(foreign,'keep'),'utf8'),'existing data');await assert.rejects(resources.ordinary(root,foreign),/escapes/);
});
async function application(t){const {root}=await fixture(t),id=randomUUID(),release=path.join(root,'releases',id,randomUUID()),state=path.join(root,'release-state',randomUUID());await fs.mkdir(release,{recursive:true});await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(release,'app.cjs'),'setInterval(()=>{},1000)');const ecosystem=path.join(state,'ecosystem.config.js'),launch={cwd:release,command:'node app.cjs',env:{NODE_OPTIONS:'--trace-warnings'}};await h.atomicJson(path.join(state,'launch.json'),launch);await fs.writeFile(ecosystem,'module.exports={apps:[]};');await h.atomicJson(path.join(root,'apps.json'),{[id]:{app:{id,name:'Fixture',port:31001},ecosystem,commit:'a'.repeat(40)}});return {root,id,ecosystem,launch};}
test('memory limits restart only the selected app, preserve other Node flags and roll back failed readiness',async t=>{
  const {root,id,ecosystem,launch}=await application(t),calls=[],name=`manager-remote-${id}`,tools={pm:async args=>{calls.push(args);return args[0]==='jlist'?JSON.stringify([{name,pid:120,pm2_env:{status:'online'}}]):'';}};let checks=0;
  const run=limitMb=>resources.execute(root,{payload:{resource:{action:'memory',id,limitMb}}},tools,{...h,healthy:async()=>{if(++checks===2)throw Error('fixture readiness failed');}});
  const result=await run(512);assert.equal(result.restored,true);assert.equal(result.healthy,false);assert.deepEqual(await h.readJson(path.join(path.dirname(ecosystem),'launch.json')),launch);assert.ok(calls.filter(a=>a[0]==='delete').every(a=>a[1]===name));
  calls.length=0;await assert.rejects(run(-1),/Invalid application memory/);assert.equal(calls.length,0);
  const good=await resources.execute(root,{payload:{resource:{action:'memory',id,limitMb:512}}},tools,h);assert.equal(good.healthy,true);const updated=await h.readJson(path.join(path.dirname(ecosystem),'launch.json'));assert.match(updated.env.NODE_OPTIONS,/--trace-warnings.*--max-old-space-size=384/);assert.match(await fs.readFile(ecosystem,'utf8'),/max_memory_restart/);
});
test('ambiguous shell commands and pinned runtimes cannot silently change to a direct launch',async t=>{
  const {launch}=await application(t);assert.equal((await resources.directPlan(launch,h)).ok,true);for(const command of ['node app.cjs && echo bad','node ../outside.cjs','npm run custom','node app.cjs --flag="space value"'])assert.equal((await resources.directPlan({...launch,command},h)).ok,false);assert.equal((await resources.directPlan({...launch,env:{MANAGER_NODE_VERSION:'24.1.0'}},h)).ok,false);
});
test('staging gateway scopes Caddy routing, forwards requests and survives enabling/disabling sleep',async t=>{
  const {root,id}=await application(t),backend=http.createServer((_req,res)=>res.end('fixture app'));await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>backend.close(r)));
  const saved=await h.readJson(path.join(root,'apps.json'));saved[id].app.port=backend.address().port;await h.atomicJson(path.join(root,'apps.json'),saved);const routes=[],tools={pm:async args=>args[0]==='jlist'?JSON.stringify([{name:`manager-remote-${id}`,pm2_env:{status:'online'}}]):''},helpers={...h,managedCaddyConfig:async(_root,apps)=>resources.proxyApps(root,apps,h),proxyConfig:async(_root,apps)=>routes.push(apps)};
  await assert.rejects(resources.execute(root,{payload:{resource:{action:'sleep',id,environment:'production',minutes:60}}},tools,helpers),/Only managed staging/);
  await resources.execute(root,{payload:{resource:{action:'sleep',id,environment:'staging',minutes:60}}},tools,helpers);const port=routes.at(-1)[0].port;assert.notEqual(port,backend.address().port);assert.equal(await(await fetch(`http://127.0.0.1:${port}/`)).text(),'fixture app');
  await resources.execute(root,{payload:{resource:{action:'sleep',id,environment:'staging',minutes:null}}},tools,helpers);assert.equal(routes.at(-1)[0].port,backend.address().port);
});
test('scheduled commands execute in the selected application environment and redact its secrets',async t=>{
  const {root,id,ecosystem,launch}=await application(t);launch.env={...process.env,RESOURCE_FIXTURE_SECRET:'private-fixture-credential'};await h.atomicJson(path.join(path.dirname(ecosystem),'launch.json'),launch);
  const tools={pm:async()=> '[]'},result=await resources.execute(root,{payload:{resource:{action:'cron-run',id:randomUUID(),config:{projectId:id,command:'node -p "process.env.RESOURCE_FIXTURE_SECRET"',workingDirectory:launch.cwd,timeoutSeconds:10}}}},tools,h);
  assert.match(result.output,/redacted/);assert.doesNotMatch(result.output,/private-fixture-credential/);
  await assert.rejects(resources.execute(root,{payload:{resource:{action:'cron-run',id:randomUUID(),config:{projectId:randomUUID(),command:'node --version',workingDirectory:launch.cwd,timeoutSeconds:10}}}},tools,h),/Deploy the selected/);
});
test('reviewed recovery rechecks live readiness and never restarts a healthy app or database dependency failure',async t=>{
  const {root,id}=await application(t);let status=200,body={ready:true},calls=[];
  const server=http.createServer((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const saved=await h.readJson(path.join(root,'apps.json'));saved[id].app.port=server.address().port;saved[id].app.health_path='/';await h.atomicJson(path.join(root,'apps.json'),saved);
  const tools={pm:async args=>{calls.push(args);return args[0]==='jlist'?JSON.stringify([{name:`manager-remote-${id}`,pid:333,pm2_env:{status:'online',restart_time:2}}]):''}},input={action:'recovery',id,pid:333,restarts:2,commit:'a'.repeat(40),port:server.address().port,health_path:'/'};
  await assert.rejects(resources.execute(root,{payload:{resource:input}},tools,h),/healthy now/);status=503;body={check:'database',issues:['credentials secret-value']};await assert.rejects(resources.execute(root,{payload:{resource:input}},tools,h),/database dependency/);assert.equal(calls.some(args=>args[0]==='restart'),false);
  const sample=(await agent.sampleApplications(saved,[{name:`manager-remote-${id}`,pm2_env:{status:'online'},monit:{}}],false))[0];assert.equal(sample.check.diagnostics.issueCode,'database-authentication');assert.doesNotMatch(JSON.stringify(sample),/secret-value/);
});
test('host and remote infrastructure navigation retain every shared section',()=>{
  const nav=load('components/synergy/nav.ts',{'@/lib/server-navigation':load('lib/server-navigation.ts',{})}),root='/infrastructure/servers/'+randomUUID(),remote=nav.workspaceInfrastructureItems(root);
  for(const item of nav.infrastructureItems){const match=remote.find(r=>r.label===item.label);assert.ok(match,item.label);assert.equal(match.icon,item.icon);if(item.href!=='/infrastructure/servers')assert.ok(match.href.startsWith(root),item.label);}
  assert.ok(remote.some(r=>r.label==='Memory'));assert.ok(remote.some(r=>r.label==='Disk cleanup'));assert.ok(remote.some(r=>r.label==='Agent access & updates'));
});
test('scoped infrastructure client never falls back to host APIs',async()=>{
  const client=load('lib/infrastructure-client.ts',{}),old=global.fetch,calls=[],id=randomUUID();global.fetch=async(url,init)=>{calls.push({url,init});return Response.json({ok:true})};
  try{for(const endpoint of ['/api/server/memory','/api/system/release-cleanup','/api/automation/cron','/api/operations'])await client.scopedInfrastructureFetch(id,endpoint);assert.ok(calls.every(c=>c.url.startsWith(`/api/servers/${id}/resources/`)));const length=calls.length;await assert.rejects(client.scopedInfrastructureFetch(id,'/api/unmapped'),/no remote-server destination/);assert.equal(calls.length,length);await client.scopedInfrastructureFetch(id,'/api/server/databases');assert.equal(calls.at(-1).init.method,'POST');assert.match(calls.at(-1).url,/\/databases\/inspect$/);}finally{global.fetch=old;}
});
test('resource API rejects viewer mutations, cross-origin requests and wrong-server apps',async()=>{
  let role='viewer',calls=0;const serverId=randomUUID(),api={ApiError,jsonError:e=>Response.json({error:e.message},{status:e.status||500})};
  const route=load('app/api/servers/[id]/resources/[[...path]]/route.ts',{'next/server':{NextResponse:Response},'@/lib/api':api,'@/lib/auth':{getSessionFromCookie:async()=>({id:randomUUID(),role})},'@/lib/rbac':{requireRole:(u,roles)=>{if(!roles.includes(u.role))throw new ApiError('Forbidden',403)}},'@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':api}),'@/lib/managed-servers':{serverDetail:async()=>({apps:[]})},'@/lib/remote-resources':{queueResource:async()=>{calls++;return{}}},'@/lib/remote-automation':{},'@/lib/remote-operations':{},'@/lib/remote-databases':{},'@/lib/update-maintenance':{updateProtected:(_label,run)=>run()}});
  const context={params:Promise.resolve({id:serverId,path:['apps',randomUUID(),'memory']})},request=origin=>new Request('https://manager.test/api/servers/'+serverId+'/resources/apps/x/memory',{method:'POST',headers:{host:'manager.test',origin,'content-type':'application/json'},body:'{"limitMb":512}'});
  assert.equal((await route.POST(request('https://manager.test'),context)).status,403);role='admin';assert.equal((await route.POST(request('https://foreign.test'),context)).status,403);assert.equal((await route.POST(request('https://manager.test'),context)).status,404);assert.equal(calls,0);
});
test('real database resource operations isolate servers, serialize admission, retain samples and dispatch schedules once',{skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pool=new(require('pg').Pool)({connectionString:url.href,max:12}),query=(sql,args)=>pool.query(sql,args);t.after(()=>pool.end());
  await query('create extension if not exists pgcrypto;create table if not exists users(id uuid primary key);create table if not exists github_connections(id uuid primary key);create table if not exists audit_logs(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),action text,resource text,details jsonb)');
  const user=randomUUID();await query('insert into users values($1)',[user]);process.env.MANAGER_ENCRYPTION_KEY='isolated-resources-test-key';const secret=load('lib/secret-crypto.ts',{}),db={db:pool,query},api={ApiError};
  const mocks={'@/lib/api':api,'@/lib/db':db,'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':secret,'@/lib/git-provider-policy':{},'@/lib/github-connections':{},'@/lib/remote-setup-policy':{},'@/scripts/manager-agent.cjs':agent};
  const managed=load('lib/managed-servers.ts',mocks),policy=load('lib/server-memory-policy.ts',{});
  const res=load('lib/remote-resources.ts',{'./api':api,'./db':db,'./secret-crypto':secret,'./managed-servers':managed,'./server-memory-policy':policy,'@/scripts/manager-agent-resources.cjs':resources});
  const automation=load('lib/remote-automation.ts',{'./api':api,'./db':db,'./managed-servers':managed,'./remote-resources':res});mocks['@/lib/remote-automation']=automation;
  const a=await managed.addServer({name:'Resource A',platform:'win32'},user),b=await managed.addServer({name:'Resource B',platform:'win32'},user);
  const sample={...metrics(),capabilities:[resources.CAPABILITY,agent.INFRASTRUCTURE_CAPABILITY,agent.CONSOLE_CAPABILITY],resources:resources.sanitize({at:new Date().toISOString(),root:'C:\\fixture',processes:[],apps:[],workers:[]})};
  await query('update managed_servers set enrolled_at=now(),last_seen_at=now(),metrics=$2 where id=any($1::uuid[])',[[a.id,b.id],JSON.stringify(sample)]);
  const app=await managed.saveRemoteApp(a.id,null,{name:'App A',repo_url:'https://github.com/example/test',branch:'main',port:31234,start_cmd:'node app.cjs',access_mode:'lan',hostname:'a.example.test'},user);await query('update remote_apps set live_commit=$2 where id=$1',[app.id,'a'.repeat(40)]);
  await assert.rejects(res.queueResource(b.id,{action:'memory',id:app.id,limitMb:512},user),e=>e.status===409);
  const both=await Promise.allSettled([res.queueResource(a.id,{action:'memory',id:app.id,limitMb:512},user),res.queueResource(a.id,{action:'start-method',id:app.id,method:'runner'},user)]);assert.equal(both.filter(r=>r.status==='fulfilled').length,1);
  const {job}=await managed.claimJob(a.id);assert.equal(job.payload.requiredCapability,resources.CAPABILITY);assert.equal(job.kind,'infrastructure');await managed.reportJob(a.id,{id:job.id,claimToken:job.claimToken,status:'success',sequence:1,log:'fixture completed',result:{ok:true,healthy:true}});
  await res.recordRemoteMemory(a.id,sample);await res.recordRemoteMemory(a.id,sample);assert.equal((await query('select count(*)::int n from remote_memory_samples where server_id=$1',[a.id])).rows[0].n,1);assert.equal((await res.remoteMemory(a.id)).history.length,1);assert.equal((await res.remoteMemory(b.id)).history.length,0);
  const cfg={name:'Fixture schedule',description:'',command:'node --version',workingDirectory:'C:\\fixture',enabled:true,language:'node',schedule:'* * * * *',timezone:'UTC',timeoutSeconds:30,projectId:app.id};
  await assert.rejects(automation.changeAutomation(b.id,'cron',undefined,'save',cfg,user),e=>e.status===400);
  await automation.changeAutomation(a.id,'cron',undefined,'save',cfg,user);const schedule=(await automation.automationList(a.id,'cron'))[0];await query('update remote_automations set next_run_at=now()-interval \'1 minute\' where id=$1',[schedule.id]);await automation.remoteResourceTick();await automation.remoteResourceTick();assert.equal((await query("select count(*)::int n from remote_jobs where server_id=$1 and resource_action='cron-run'",[a.id])).rows[0].n,1);
  await query("update remote_jobs set status='cancelled' where server_id=$1 and status='queued'",[a.id]);
  const queued=await automation.changeAutomation(a.id,'worker',undefined,'save',{name:'Owned worker',description:'',command:'node worker.cjs',workingDirectory:'C:\\fixture',enabled:false,pm2Name:'worker-label'},user);const reserved=(await automation.automationList(a.id,'worker'))[0];assert.ok(reserved);const claimed=(await managed.claimJob(a.id)).job;assert.equal(claimed.id,queued.jobId);await managed.reportJob(a.id,{id:claimed.id,claimToken:claimed.claimToken,status:'success',sequence:1,log:'saved',result:{ok:true}});assert.equal((await automation.automationList(a.id,'worker'))[0].name,'Owned worker');assert.equal((await automation.automationList(b.id,'worker')).length,0);
  await query('update managed_servers set last_seen_at=$2 where id=$1',[a.id,new Date(0)]);await assert.rejects(res.queueResource(a.id,{action:'disk',mode:'scan'},user),e=>e.status===409);
});
