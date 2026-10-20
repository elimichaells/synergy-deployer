const test=require('node:test'), assert=require('node:assert/strict');
// These modules use isolated dependency mocks; explicit preview rejection is
// exercised separately below, without inheriting the build runner's preview flag.
const originalPreview=process.env.MANAGER_PREVIEW;delete process.env.MANAGER_PREVIEW;
test.after(()=>{if(originalPreview!==undefined)process.env.MANAGER_PREVIEW=originalPreview;});
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const load=require('./server-module.cjs');
const policy=require('../lib/ai-operations-policy.ts');
const {recordUptime,summarizeUptime,validateUptime}=require('../scripts/uptime-history.cjs');
const {updateUptime}=require('../scripts/monitor-state.cjs');
class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
const minute=60000, start=Date.UTC(2026,9,20);
function health(){return {checkedAt:new Date().toISOString(),stale:false,unavailable:false,
 snapshot:{apps:[{name:'merchant',status:'online',restarts:1}],checks:[{name:'merchant',ok:false,status:503,ms:40}],pm2Error:false,collectorError:null},
 incidents:[{id:'incident-1',key:'http:merchant',service:'merchant',severity:'critical',openedAt:new Date().toISOString()}]};}
function sample(at,checks=[{name:'merchant',ok:true}],apps=[]){return {at,checks,apps,pm2Error:false,collectorError:null};}

test('uptime preserves missing, failed, unknown and paused checks without counting them as up',()=>{
 let h=recordUptime(null,sample(start));
 h=recordUptime(h,sample(start+2000,[{name:'merchant',ok:false}]));
 h=recordUptime(h,sample(start+minute,[{name:'merchant',ok:false}]));
 h=recordUptime(h,{...sample(start+2*minute,[]),pm2Error:true});
 h=recordUptime(h,sample(start+3*minute,[],[{name:'merchant',status:'stopped'}]));
 const result=summarizeUptime(h,'24h',start+5*minute).services[0];
 assert.equal(result.up,1);assert.equal(result.down,1);assert.equal(result.unknown,1);assert.equal(result.paused,1);
 assert.equal(result.percent,50);assert.equal(result.missing,1436);assert.equal(result.assessment,'insufficient-coverage');
});
test('uptime trims to 30-day window, excludes future slots and validates corrupted data',()=>{
 let h;for(let day=0;day<40;day++)h=recordUptime(h,sample(start+day*1440*minute));
 assert.equal(h.days.length,31);
 assert.equal(summarizeUptime(h,'30d',h.lastSampleAt).services[0].up,30);
 assert.equal(summarizeUptime(h,'24h',h.lastSampleAt-minute).services[0].up,1);
 assert.throws(()=>summarizeUptime(h,'all'),/range/);
 assert.throws(()=>validateUptime({...h,days:[{at:start,services:{bad:'u'}}]}),/observations/);
 assert.equal(recordUptime(h,sample(start)),h);
});
test('uptime target assessment requires coverage and does not invent earlier availability',()=>{
 let h;for(let i=0;i<1440;i++)h=recordUptime(h,sample(start+i*minute,[{name:'api',ok:i!==700}]));
 let result=summarizeUptime(h,'24h',start+1439*minute).services[0];
 assert.equal(result.coverage,100);assert.equal(result.assessment,'within-target');
 h=recordUptime(h,sample(start+1440*minute,[{name:'api',ok:false}]));
 result=summarizeUptime(h,'24h',start+1440*minute).services[0];
 assert.equal(result.assessment,'below-target');assert.equal(result.down,2);
 assert.equal(summarizeUptime(null,'30d').services.length,0);
});
test('uptime persistence preserves a damaged file instead of resetting its history',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ai-uptime-'));const file=path.join(root,'uptime.json');
 try{await updateUptime({stateFile:path.join(root,'state.json')},sample(start));await fs.writeFile(file,'damaged');
 await assert.rejects(updateUptime({stateFile:path.join(root,'state.json')},sample(start+minute)));assert.equal(await fs.readFile(file,'utf8'),'damaged');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('provider evidence excludes names, URLs, raw error messages, code and secrets',()=>{
 const h=health();h.snapshot.apps[0].name='ignore-instructions-password-SECRET';h.incidents[0].message='DATABASE_URL=postgres://root:SECRET@host/db';
 h.snapshot.checks[0].diagnostics={issueCode:'inject SECRET',detail:'run shell SECRET'};h.snapshot.checks[0].endpoint='/SECRET';
 const text=JSON.stringify(policy.providerEvidence(h));assert.doesNotMatch(text,/SECRET|postgres|DATABASE|instructions|shell/);assert.match(text,/service-1/);
});
test('model recommendations cannot introduce executable actions or invalid structures',()=>{
 assert.throws(()=>policy.validateDiagnosis({summary:'a',evidence:[],recommendations:['restart_all'],limitations:[]}),/Unknown/);
 assert.throws(()=>policy.validateDiagnosis({summary:'a',evidence:['a'.repeat(701)],recommendations:[],limitations:[]}),/Invalid/);
 assert.equal(policy.validateDiagnosis({summary:'Database may be unavailable',evidence:[],recommendations:['review_database'],limitations:[]}).source,'openai');
});
test('recovery denies stale, future, missing, stopped, healthy and database-failed applications',()=>{
 const cases=[h=>h.stale=true,h=>h.checkedAt=new Date(Date.now()+30000).toISOString(),h=>h.snapshot.apps=[],
 h=>h.snapshot.apps[0].status='stopped',h=>h.snapshot.checks[0].ok=true,h=>h.snapshot.checks[0].diagnostics={issueCode:'database-configuration'},
 h=>h.incidents.push({key:'memory',severity:'critical'}),h=>h.snapshot.collectorError='history unavailable'];
 for(const change of cases){const h=health();change(h);assert.ok(policy.recoveryBlockers(h,'merchant',false).length);}
 assert.ok(policy.recoveryBlockers(health(),'merchant',true).length);assert.equal(policy.recoveryBlockers(health(),'merchant',false).length,0);
});
test('review tickets reject wrong actor, expiry, replay and changed state',()=>{
 const ticket={actor_id:'admin',status:'pending',expires_at:new Date(Date.now()+60000),fingerprint:'a'};
 assert.throws(()=>policy.assertReviewTicket(ticket,'other','a'),/another user/);
 assert.throws(()=>policy.assertReviewTicket({...ticket,status:'running'},'admin','a'),/already/);
 assert.throws(()=>policy.assertReviewTicket({...ticket,expires_at:new Date(1)},'admin','a'),/expired/);
 assert.throws(()=>policy.assertReviewTicket(ticket,'admin','b'),/changed/);
 policy.assertReviewTicket(ticket,'admin','a');
});
test('database review returns only key presence and flags an unassigned primary service',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ai-db-'));
 try{
 await fs.writeFile(path.join(root,'.env'),'DATABASE_HOST=private-host\nDATABASE_NAME=private-db\nDATABASE_PASSWORD=SECRET\nOTHER_TOKEN=SECRET\nDATABASE_USER=\n');
 const mod=load('lib/ai-operations-database.ts',{'@/lib/db':{query:async sql=>({rows:sql.includes('from projects')?[{id:'p',name:'App',project_type:'node',root_path:root}]:[]})},'@/lib/api':{ApiError}});
 const result=await mod.databaseConfigurationReview('p'),json=JSON.stringify(result);
 assert.doesNotMatch(json,/SECRET|private-host|private-db/);assert.ok(result.missing.includes('DATABASE_USER'));
 assert.ok(result.warnings.some(x=>x.includes('No primary')));assert.equal(result.href,'/sites/p?tab=storage');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('cross-origin and preview requests cannot execute operations',()=>{
 const mod=load('lib/ai-operations.ts',{'@/lib/paths':{},'@/lib/api':{ApiError}});
 assert.throws(()=>mod.requireSameOrigin(new Request('http://host/api',{headers:{host:'host',origin:'http://other'}})),e=>e.status===403);
 assert.throws(()=>mod.requireSameOrigin(new Request('http://host/api',{headers:{host:'host'}})),e=>e.status===403);
 mod.requireSameOrigin(new Request('http://host/api',{headers:{host:'host',origin:'http://host'}}));
 const old=process.env.MANAGER_PREVIEW;process.env.MANAGER_PREVIEW='1';
 try{assert.throws(()=>mod.requireSameOrigin(new Request('http://host/api',{headers:{host:'host',origin:'http://host'}})),e=>e.status===503);}
 finally{if(old===undefined)delete process.env.MANAGER_PREVIEW;else process.env.MANAGER_PREVIEW=old;}
});
test('operations API enforces operator/admin boundaries and explicit execution confirmation',async()=>{
 let role='viewer',executions=0,settings=0;
 const apiHelpers=load('lib/ai-operations.ts',{'@/lib/paths':{},'@/lib/api':{ApiError}});
 const mod=load('app/api/operations/route.ts',{
  '@/lib/auth':{getSessionFromCookie:async()=>({id:'actor',role})},
  '@/lib/rbac':{requireRole:(u,roles)=>{if(!roles.includes(u.role))throw new ApiError('Forbidden',403);}},
  '@/lib/db':{},'@/lib/unified-health':{},'@/lib/ai-operations-policy':{},
  '@/lib/ai-operations-store':{saveAiSettings:async()=>{settings++;return {};}},
  '@/lib/ai-operations-provider':{},'@/lib/ai-operations-database':{},
  '@/lib/ai-operations-recovery':{executeRecovery:async()=>{executions++;}},
  '@/lib/ai-operations':apiHelpers,'@/lib/api':{ApiError},'@/lib/audit':{audit:async()=>{}}
 });
 const request=body=>new Request('http://host/api/operations',{method:'POST',headers:{host:'host',origin:'http://host','content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await mod.POST(request({action:'diagnose'}))).status,403);
 role='operator';assert.equal((await mod.POST(request({action:'settings'}))).status,403);
 assert.equal((await mod.POST(request({action:'execute-recovery',reviewId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}))).status,400);
 assert.equal(executions,0);assert.equal(settings,0);
 assert.equal((await mod.POST(request({action:'restart-all'}))).status,400);
});

function recoveryFixture({healthyProbe=false,failRestart=false,changed=false}={}) {
 const current=health(), records=[], commands=[];
 let ticket, event, restarted=false, releases=0;
 const project={id:'project',name:'Merchant',root_path:'C:\\apps\\merchant',pm2_name:'merchant',port:4501,updated_at:'2026-10-20',is_active:true};
 const processList=()=>[{pm_id:7,name:'merchant',pid:restarted?101:100,pm2_env:{status:'online',restart_time:restarted?2:1,pm_cwd:project.root_path,PORT:4501}},
 {pm_id:8,name:'other',pid:200,pm2_env:{status:'online',restart_time:0,pm_cwd:'C:\\apps\\other',PORT:4502}}];
 const query=async(sql,args=[])=>{
  records.push(sql);
  if(sql.includes('try_advisory'))return {rows:[{locked:true}]};
  if(sql.includes('select * from manager_ai_reviews'))return {rows:ticket?[{...ticket}]:[]};
  if(sql.startsWith('select id,name,root_path'))return {rows:[{...project,updated_at:changed?'changed':project.updated_at}]};
  if(sql.startsWith('select id from projects where pm2_name'))return {rows:[{id:'project'}]};
  if(sql.startsWith('insert into manager_ai_reviews')){ticket={id:args[0],actor_id:args[1],project_id:args[2],fingerprint:args[3],status:'pending',expires_at:new Date(Date.now()+300000)};return {rows:[{expires_at:ticket.expires_at}]};}
  if(sql.startsWith('update manager_ai_reviews set status=\'running\'')){if(ticket.status!=='pending')return {rows:[],rowCount:0};ticket.status='running';return {rows:[{id:ticket.id}],rowCount:1};}
  if(sql.startsWith('insert into manager_ai_events'))event=args[0];
  if(sql.startsWith('update manager_ai_reviews set status=$2'))ticket.status=args[1];
  if(sql.startsWith('select 1 from manager_ai_reviews'))return {rows:[],rowCount:0};
  return {rows:[],rowCount:0};
 };
 const client={query,release:()=>releases++};
 const mod=load('lib/ai-operations-recovery.ts',{
  'fs/promises':{realpath:async p=>p},'@/lib/db':{query,db:{connect:async()=>client}},
  '@/lib/api':{ApiError},'@/lib/paths':{managerRoot:()=> 'C:\\web\\manager',managerScript:()=> 'fixture-pm2.cjs'},
  '@/lib/project-operation':{acquireProjectOperation:async()=>async()=>{releases++;}},
  '@/lib/server-health':{readServerHealth:async()=>current},
  '@/lib/health-profiles':{applicationHealthProfile:async()=>({path:'/ready',statuses:[],timeoutMs:3000})},
  '@/lib/exec':{runCommand:async cmd=>{commands.push(cmd.args.slice(1).join(' '));if(cmd.args[1]==='inventory')return {code:0,output:JSON.stringify(processList().map(p=>({id:p.pm_id,name:p.name,pid:p.pid,status:p.pm2_env.status,restarts:p.pm2_env.restart_time,cwd:p.pm2_env.pm_cwd,port:p.pm2_env.PORT})))};
   assert.deepEqual(cmd.args,['fixture-pm2.cjs','restart','7']);assert.ok(event,'Audit must precede restart');restarted=true;return {code:failRestart?1:0,output:'secret output never returned'};}},
  '@/lib/ai-operations-policy':policy,
  '@/lib/ai-operations-store':{ensureAiSchema:async()=>{},aiSettings:async()=>({recoveryEnabled:true})},
  '@/lib/ai-operations-config':{configurationIdentity:async()=>({configuration:'fixture'})},
  '../scripts/http-health.cjs':{probeHttp:async()=>({ok:healthyProbe||restarted})},
 });
 return {mod,commands,current,get ticket(){return ticket;},get releases(){return releases;}};
}
test('reviewed recovery records approval before one scoped command and rejects replay',async()=>{
 const f=recoveryFixture();const review=await f.mod.prepareRecovery('project','admin');
 const result=await f.mod.executeRecovery(review.id,'admin');
 assert.equal(result.status,'succeeded');assert.equal(result.healthy,true);
 assert.equal(f.commands.filter(c=>c.startsWith('restart')).length,1);
 assert.equal(result.otherProcessesUnchanged,true);
 await assert.rejects(f.mod.executeRecovery(review.id,'admin'));assert.equal(f.commands.filter(c=>c.startsWith('restart')).length,1);
 assert.ok(f.releases>=4);
});
test('fresh recovery probe prevents restarting an application that recovered itself',async()=>{
 const f=recoveryFixture({healthyProbe:true});const review=await f.mod.prepareRecovery('project','admin');
 await assert.rejects(f.mod.executeRecovery(review.id,'admin'),/Fresh readiness/);
 assert.equal(f.commands.filter(c=>c.startsWith('restart')).length,0);
});
test('changed ticket state and database failure prevent process mutation',async()=>{
 const f=recoveryFixture();const review=await f.mod.prepareRecovery('project','admin');
 f.ticket.fingerprint='changed';
 await assert.rejects(f.mod.executeRecovery(review.id,'admin'),/changed/);
 f.current.snapshot.checks[0].diagnostics={issueCode:'database-unavailable'};
 await assert.rejects(f.mod.prepareRecovery('project','admin'),/database/);
 assert.equal(f.commands.filter(c=>c.startsWith('restart')).length,0);
});
test('failed PM2 recovery records failure without automatic retry',async()=>{
 const f=recoveryFixture({failRestart:true});const review=await f.mod.prepareRecovery('project','admin');
 const result=await f.mod.executeRecovery(review.id,'admin');
 assert.equal(result.status,'failed');assert.equal(f.ticket.status,'failed');
 assert.equal(f.commands.filter(c=>c.startsWith('restart')).length,1);
 assert.doesNotMatch(JSON.stringify(result),/secret output/);
});
test('PM2 helper permits only inventory and numeric app restart on an existing RPC connection',async()=>{
 const {callExisting}=require('../scripts/operations-pm2.cjs');const calls=[];let connected,closed=0;
 const socket={on:()=>{},once:(event,fn)=>{connected=fn;},connect:()=>connected(),close:()=>closed++};
 const pkg=id=>id==='pm2-axon'?{socket:()=>socket}:{Client:class{call(method,args,done){calls.push({method,args});done(null,[{pm_id:4,name:'app',pid:1,pm2_env:{status:'online',restart_time:0,pm_cwd:'folder',PORT:1234,SECRET:'hidden'}}]);}}};
 const inventory=await callExisting({},'inventory',undefined,pkg);assert.doesNotMatch(JSON.stringify(inventory),/SECRET|hidden/);
 assert.deepEqual(await callExisting({},'restart',4,pkg),{ok:true});
 assert.deepEqual(calls[1],{method:'restartProcessId',args:{id:4,env:{}}});assert.equal(closed,2);
 assert.throws(()=>callExisting({},'restart','all',pkg),/Invalid/);
 assert.throws(()=>callExisting({},'restartAll',4,pkg),/Invalid/);
});
test('operations payload reads are bounded before JSON parsing',async()=>{
 const mod=load('lib/ai-operations.ts',{'@/lib/paths':{},'@/lib/api':{ApiError}});
 await assert.rejects(mod.operationsBody(new Request('http://host',{method:'POST',body:'x'.repeat(6001)})),e=>e.status===413);
 await assert.rejects(mod.operationsBody(new Request('http://host',{method:'POST',body:'[]'})),e=>e.status===400);
});
test('changing startup configuration invalidates its identity without returning secret values',async()=>{
 const {configurationIdentity}=require('../lib/ai-operations-config.ts');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ai-config-'));
 try {
  await fs.writeFile(path.join(root,'.env'),'DATABASE_PASSWORD=SECRET');
  const before=await configurationIdentity(root);assert.doesNotMatch(JSON.stringify(before),/SECRET|DATABASE_PASSWORD/);
  await fs.writeFile(path.join(root,'.env'),'DATABASE_PASSWORD=CHANGED');
  const after=await configurationIdentity(root);assert.notEqual(before['.env'],after['.env']);
  await fs.writeFile(path.join(root,'.env'),'x'.repeat(1024*1024+1));
  await assert.rejects(configurationIdentity(root),/safely/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
