const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {probeHttp,validateHealthProfile}=require('../scripts/http-health.cjs');
const {startupDecision}=require('../scripts/pm2-startup-policy.cjs');
const {gitInspectionError}=require('../lib/deployment-git-error.ts');
const {customStartupWarning}=require('../lib/startup-diagnostics.ts');
const {createDeploymentLogWriter}=require('../lib/deployment-log.ts');
const {applicationState}=require('../lib/application-health.ts');
const load=require('./server-module.cjs');

test('readiness follows a login redirect and detects the failing destination',async()=>{
 const paths=[];const server=createServer((req,res)=>{paths.push(req.url);if(req.url==='/'){res.writeHead(307,{Location:'/login'});}else res.writeHead(500);res.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const result=await probeHttp('http://127.0.0.1:'+server.address().port);assert.equal(result.ok,false);assert.equal(result.status,500);assert.deepEqual(paths,['/','/login']);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('readiness refuses external redirects, loops, and default 404; explicit expected codes work',async()=>{
 let calls=0;const external=await probeHttp('http://127.0.0.1:1234/',{},async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1:9999/private'}})});assert.equal(calls,1);assert.equal(external.ok,false);
 const loop=await probeHttp('http://127.0.0.1:1234/',{},async()=>new Response(null,{status:302,headers:{Location:'/'}}));assert.match(loop.reason,/loop/);
 assert.equal((await probeHttp('http://127.0.0.1/',{},async()=>new Response(null,{status:404}))).ok,false);
 assert.equal((await probeHttp('http://127.0.0.1/',{statuses:[401]},async()=>new Response(null,{status:401}))).ok,true);
});
test('profiles reject external paths, fragments, shell controls, and invalid response codes',()=>{
 for(const path of ['https://bad','//bad','/\\bad','/ok\n','/health?secret=x'])assert.throws(()=>validateHealthProfile({path}));
 for(const statuses of [[500],[302],['200']])assert.throws(()=>validateHealthProfile({statuses}));
 assert.throws(()=>validateHealthProfile({timeoutMs:999999}));assert.equal(validateHealthProfile({path:'/api/health'}).timeoutMs,60000);
});
test('startup is idempotent and refuses duplicate daemon or incomplete saved state',()=>{
 const saved=[{name:'live',pm_exec_path:'app.js',status:'online'},{name:'disabled',pm_exec_path:'old.js',status:'stopped'}];
 assert.equal(startupDecision(saved,[{name:'live',pm2_env:{status:'online'}}],true),'already-running');
 assert.equal(startupDecision(saved,null,false),'resurrect');
 assert.throws(()=>startupDecision(saved,null,true),/second daemon/);
 assert.throws(()=>startupDecision(saved,[],true),/scoped recovery/);
 assert.throws(()=>startupDecision([],null,false),/empty or invalid/);
});
test('Git diagnostics explain ownership without echoing secrets; custom startup cannot be silently bypassed',()=>{
 const error=gitInspectionError('fatal: detected dubious ownership https://secret@host/repo');assert.match(error,/owner differs/);assert.doesNotMatch(error,/secret/);
 assert.equal(customStartupWarning('next',null,{start:'next start -p 3010'}),null);
 assert.match(customStartupWarning('next',null,{start:'node scripts/start.mjs'}),/npm run start/);
 assert.equal(customStartupWarning('next','npm run start',{start:'node scripts/start.mjs'}),null);
});
test('log writer batches output, serializes pending writes and flushes once at close',async()=>{
 const writes=[];let release;const writer=createDeploymentLogWriter(async chunk=>{writes.push(chunk);if(writes.length===1)await new Promise(r=>release=r)},10000);
 writer.append('A');writer.append('😀');const flush=writer.flush();writer.append('B');release();await flush;await writer.close();assert.deepEqual(writes,['A😀','B']);assert.throws(()=>writer.append('C'),/closed/);
});
test('enabled flags never establish readiness and stale observations become unknown',()=>{
 const health={stale:false,unavailable:false,snapshot:{pm2Error:false,apps:[{name:'app',status:'online',health:'degraded'}]}};
 assert.equal(applicationState(health,'app'),'degraded');assert.equal(applicationState({...health,stale:true},'app'),'unknown');assert.equal(applicationState(health,'missing'),'unknown');
});
test('a log persistence failure cannot prevent recovery diagnostics',async()=>{
 const writer=createDeploymentLogWriter(async()=>{throw new Error('database unavailable')},10000);
 writer.append('before');await assert.rejects(writer.flush(),/database unavailable/);
 assert.doesNotThrow(()=>writer.append('rollback diagnostics'));
 await assert.rejects(writer.close(),/database unavailable/);
});
test('unified alerts preserve independent monitor state when database sources fail',async()=>{
 const api=load('lib/unified-health.ts',{'@/lib/health-db':{query:async()=>{throw new Error('password=private')}},'@/lib/server-health':{readServerHealth:async()=>({checkedAt:'2026-10-15T00:00:00Z',stale:false,unavailable:false,snapshot:null,incidents:[{id:'disk',key:'disk',severity:'critical',message:'Disk low',action:'Inspect',openedAt:'2026-10-15T00:00:00Z',lastSeenAt:'2026-10-15T00:00:00Z'}]})}});
 const result=await api.readUnifiedHealth();assert.equal(result.incidents.length,4);assert.equal(result.incidents[0].id,'disk');assert.doesNotMatch(JSON.stringify(result),/private/);
});
