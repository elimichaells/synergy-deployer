const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {recordHistory,summarizeHistory}=require('../scripts/health-history.cjs');
const {updateHistory,acquireMonitorLock}=require('../scripts/monitor-state.cjs');
const {probeHttp}=require('../scripts/http-health.cjs');
const {conditionsFor,advanceState}=require('../scripts/server-monitor-policy.cjs');
const {NextRequest}=require('next/server');const load=require('./server-module.cjs');
const start=Date.UTC(2026,9,19,12),minute=60_000;
const sample=(at,checks=[],apps=[])=>({at,checks,apps,disks:[],logs:[],memory:{free:8e9,total:16e9},pm2Updates:0,pm2Error:false,collectorError:null});
const check=(ok,ms=25)=>({name:'merchant',ok,status:ok?200:503,ms});

test('history does not count duplicate minutes, stopped apps or missing samples as success',()=>{
 let h=recordHistory(null,sample(start,[check(true)]));
 h=recordHistory(h,sample(start+5000,[check(false)]));
 h=recordHistory(h,sample(start+minute,[check(false,75)]));
 h=recordHistory(h,sample(start+2*minute,[],[{name:'merchant',status:'stopped'}]));
 h=recordHistory(h,{...sample(start+3*minute),pm2Error:true});
 const result=summarizeHistory(h,'1h','merchant',start+10*minute);
 assert.equal(result.summary.successPercent,50);assert.equal(result.summary.averageMs,50);assert.equal(result.summary.paused,1);assert.equal(result.summary.unknown,1);
 assert.ok(result.points.some(p=>p.state==='gap'));assert.equal(result.summary.passed,1);
 const partial=summarizeHistory(recordHistory(null,sample(start,[check(true)])),'1h','merchant',start+4*minute);
 assert.equal(partial.points.find(p=>p.at===start).state,'partial');assert.equal(partial.points.find(p=>p.at===start).missing,3);
});
test('history rolls up seven days, filters services, and excludes future/stale observations',()=>{
 let h;for(let i=0;i<9*24*12;i++)h=recordHistory(h,sample(start+i*5*minute,[check(true),{name:'api',ok:false,status:null,ms:4000}]));
 assert.ok(h.buckets.length<=2017);
 const result=summarizeHistory(h,'7d','api',h.lastSampleAt+minute);
 assert.ok(result.points.length<=169);assert.equal(result.summary.passed,0);assert.equal(result.summary.averageMs,null);assert.equal(result.services.length,2);
 assert.throws(()=>summarizeHistory(h,'all'),/range/);
 assert.equal(recordHistory(h,sample(start)),h);
});
test('history initializes from existing observations and survives subsequent file writes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-history-test-'));
 try {const config={stateFile:path.join(root,'state.json')};const old={history:[sample(start,[check(true)]),sample(start+minute,[check(false)])]};
 await updateHistory(config,old,sample(start+2*minute,[check(true)]));await updateHistory(config,old,sample(start+3*minute,[check(true)]));
 const value=JSON.parse(await fs.readFile(path.join(root,'history.json'),'utf8'));assert.equal(summarizeHistory(value,'1h',undefined,start+4*minute).summary.passed,3);
 await fs.writeFile(path.join(root,'history.json'),'damaged');await assert.rejects(updateHistory(config,old,sample(start+4*minute,[check(true)])));assert.equal(await fs.readFile(path.join(root,'history.json'),'utf8'),'damaged');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('concurrent monitor writers are excluded and the lock is released',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-history-lock-'));
 try{const file=path.join(root,'state.json'),release=await acquireMonitorLock(file);assert.equal(typeof release,'function');assert.equal(await acquireMonitorLock(file),null);await release();const again=await acquireMonitorLock(file);assert.ok(again);await again();}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('diagnostics classify JSON dependency failures without retaining response secrets',async()=>{
 const response=()=>new Response(JSON.stringify({check:'configuration',ready:false,issues:['DATABASE_URL must use the merchant role. password=private postgres://admin:secret@db/internal'],token:'do-not-keep'}),{status:503,headers:{'Content-Type':'application/json'}});
 const r=await probeHttp('http://127.0.0.1:3015/api/health',{diagnostics:true},async()=>response());
 assert.equal(r.diagnostics.issueCode,'database-configuration');assert.doesNotMatch(JSON.stringify(r),/private|secret|do-not-keep|admin/);
 assert.equal((await probeHttp('http://127.0.0.1:3015/api/health',{},async()=>response())).diagnostics,undefined);
 const big=await probeHttp('http://127.0.0.1/',{diagnostics:true},async()=>new Response(JSON.stringify({database:'down',large:'x'.repeat(9000)}),{status:503,headers:{'Content-Type':'application/json'}}));assert.equal(big.status,503);assert.equal(big.diagnostics,undefined);
 const html=await probeHttp('http://127.0.0.1/',{diagnostics:true},async()=>new Response('<html>password=private</html>',{status:500}));assert.equal(html.diagnostics,undefined);
});
test('actionable incidents preserve first occurrence and update current evidence',()=>{
 const c={...check(false),endpoint:'/api/health',expected:'200',diagnostics:{dependency:'Database',issueCode:'database-unavailable',detail:'Database readiness failed.',nextStep:'Check the configured database.'}};
 let state=advanceState(null,sample(start,[c]));state=advanceState(state,sample(start+minute,[c]));const first=state.incidents[0];
 state=advanceState(state,sample(start+2*minute,[{...c,ms:70}]));const latest=state.incidents[0];
 assert.equal(latest.openedAt,first.openedAt);assert.equal(latest.responseMs,70);assert.equal(latest.service,'merchant');assert.equal(latest.action,c.diagnostics.nextStep);assert.equal(conditionsFor(sample(start,[c]))[0].dependency,'Database');
});
test('history API authorizes roles and rejects invalid query parameters before reading files',async()=>{
 let reads=0;const route=role=>load('app/api/server/health/history/route.ts',{'@/lib/auth':{getSessionFromCookie:async()=>role?{role}:null},'@/lib/rbac':require('../lib/rbac.ts'),'@/lib/api':require('../lib/api.ts'),'@/lib/health-history':{readHealthHistory:async(range,service)=>{reads++;return {range,service};}}});
 assert.equal((await route(null).GET(new NextRequest('http://test/api/server/health/history'))).status,401);assert.equal(reads,0);
 for(const role of ['viewer','operator','admin'])assert.equal((await route(role).GET(new NextRequest('http://test/api/server/health/history?range=7d&service=merchant'))).status,200);
 assert.equal((await route('viewer').GET(new NextRequest('http://test/api/server/health/history?range=year'))).status,400);assert.equal(reads,3);
});
test('preview instrumentation exits before importing any production service',async()=>{
 const before=process.env.MANAGER_PREVIEW,runtime=process.env.NEXT_RUNTIME;process.env.MANAGER_PREVIEW='1';process.env.NEXT_RUNTIME='nodejs';
 try{const module=load('instrumentation.ts',{});await module.register();}finally{if(before===undefined)delete process.env.MANAGER_PREVIEW;else process.env.MANAGER_PREVIEW=before;if(runtime===undefined)delete process.env.NEXT_RUNTIME;else process.env.NEXT_RUNTIME=runtime;}
});
test('preview middleware rejects mutation and wake requests but retains normal authentication',()=>{
 const before=process.env.MANAGER_PREVIEW;process.env.MANAGER_PREVIEW='1';
 try{const {middleware}=load('middleware.ts',{'./scripts/manager-update-state.cjs':{maintenance:()=>false}});assert.equal(middleware(new NextRequest('http://test/api/sites',{method:'POST'})).status,503);assert.equal(middleware(new NextRequest('http://test/api/wake')).status,503);assert.equal(middleware(new NextRequest('http://test/api/server/health')).status,401);assert.equal(middleware(new NextRequest('http://test/login')).status,200);}finally{if(before===undefined)delete process.env.MANAGER_PREVIEW;else process.env.MANAGER_PREVIEW=before;}
});
test('history reader fails visibly on missing, oversized or corrupt data',async()=>{
 for(const fixture of ['missing','oversized','corrupt']){
  const {readHealthHistory}=load('lib/health-history.ts',{'@/lib/paths':{managerDataRoot:()=>'/fixture'},'fs/promises':{stat:async()=>{if(fixture==='missing')throw Error('private path');return {size:fixture==='oversized'?30*1024**2:5,mtimeMs:1}},readFile:async()=>'{bad'},'../scripts/health-history.cjs':{summarizeHistory}});
  const result=await readHealthHistory('24h');assert.equal(result.unavailable,true);assert.equal(result.summary.successPercent,null);assert.doesNotMatch(JSON.stringify(result),/private path|fixture/);
 }
});
