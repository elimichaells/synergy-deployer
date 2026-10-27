const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,randomBytes}=require('node:crypto');
const http=require('node:http');
const supervisor=require('../scripts/manager-agent-supervisor.cjs');
const agent=require('../scripts/manager-agent.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(50);}throw new Error('Test condition timed out');};

function fixture(version,behavior='good') {
  return `'use strict';
const fs=require('node:fs');const path=require('node:path');
const version=${JSON.stringify(version)};
if(process.argv[2]==='version'){console.log(JSON.stringify({version,protocol:1,supervisorProtocol:1}));process.exit(0);}
const root=process.argv[process.argv.indexOf('--root')+1];
const lock=path.join(root,'agent.lock');fs.writeFileSync(lock,String(process.pid));
if(!fs.existsSync(path.join(root,'application-runtime.json')))require('node:child_process').spawn(process.execPath,[path.join(root,'app-fixture.cjs'),root],{detached:true,windowsHide:true,stdio:'ignore'}).unref();
const stop=()=>{clearInterval(timer);try{fs.unlinkSync(lock);}catch{}if(process.connected)process.disconnect();process.exit(0);};
const pulse=()=>{if(!process.connected)return;if(${JSON.stringify(behavior)}==='crash')process.exit(17);process.send({type:'idle',idle:true});if(${JSON.stringify(behavior)}==='silent')return;process.send({type:'heartbeat',version,metrics:{apps:[{id:'app-1',status:${JSON.stringify(behavior==='bad-app'?'errored':'online')}}],proxyError:null}});};
const timer=setInterval(pulse,80);process.on('message',m=>{if(m.type==='stop')stop();});process.on('disconnect',stop);process.on('SIGTERM',stop);pulse();
`;
}
function proposal(source,overrides={}) {return {id:randomUUID(),fromVersion:'1.2.0',version:'1.3.0',supervisorProtocol:1,source,sha256:supervisor.digest(source),claimToken:randomBytes(32).toString('base64url'),...overrides};}
test('versions, source digests, protocol and claim identity are checked before execution',()=>{
  const valid=proposal(fixture('1.3.0'));supervisor.validateUpdate(valid,'1.2.0');
  for(const patch of [{sha256:'a'.repeat(64)},{source:valid.source+'x'},{version:'1.1.9'},{version:'1.2.0'},{version:'1.3.0-beta'},{fromVersion:'1.1.0'},{supervisorProtocol:2},{id:'../escape'},{claimToken:'x'}])assert.throws(()=>supervisor.validateUpdate({...valid,...patch},'1.2.0'));
  assert.equal(supervisor.newer('1.10.0','1.9.9'),true);
  assert.equal(supervisor.newer('1.9.9','1.10.0'),false);
});
test('real bundled agent declares the update contract without requiring enrollment',async()=>{
  assert.deepEqual(await supervisor.inspectCandidate(path.resolve(__dirname,'../scripts/manager-agent.cjs')),{version:agent.AGENT_VERSION,protocol:1,supervisorProtocol:1});
});
test('application checks detect missing/stopped apps and a newly unhealthy proxy',()=>{
  const before={apps:[{id:'a',status:'online'},{id:'b',status:'stopped'}],proxyError:null};
  assert.equal(supervisor.appsHealthy(before,structuredClone(before)),true);
  for(const after of [{...before,apps:[]},{...before,apps:[{id:'a',status:'online'},{id:'b',status:'online'}]},{...before,proxyError:'down'}])assert.equal(supervisor.appsHealthy(before,after),false);
});
async function harness(t,behavior,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-agent-update-test-'));
  // Protected state and a separate running app must survive success AND rollback.
  const protectedFiles={'agent.json':JSON.stringify({enrolled:true,manager:'https://manager.invalid',serverId:randomUUID(),agentToken:randomBytes(32).toString('base64url')}),'apps.json':'{"application":"keep-release-and-environment"}','Caddyfile':'# preserve routing and certificate storage\n','database-data':'do not modify database files','caddy-storage/certificate':'keep certificate','apps/release/.env':'SECRET=keep-this'};
  for(const [name,bytes]of Object.entries(protectedFiles)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),bytes);}
  await fs.writeFile(path.join(root,'manager-agent.cjs'),fixture('1.2.0'));
  // The application is a descendant of the agent, like PM2/Caddy. Replacing the
  // agent must leave that exact process alive, not restart an equivalent server.
  await fs.writeFile(path.join(root,'app-fixture.cjs'),`const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const s=http.createServer((q,r)=>r.end('application healthy'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(process.argv[2],'application-runtime.json'),JSON.stringify({pid:process.pid,port:s.address().port})));`);
  let originalApp=null;
  const update=proposal(fixture('1.3.0',behavior));
  if(options.corrupt)update.sha256='f'.repeat(64);
  const reports=[];let claimed=false,acked=false,reportFailures=options.reportFailures||0;
  if(options.crashState) {
    await fs.mkdir(path.join(root,'.agent-updates',update.id),{recursive:true});
    await fs.writeFile(path.join(root,'.agent-updates',update.id,'previous.cjs'),fixture('1.2.0'));
    await fs.writeFile(path.join(root,'manager-agent.cjs'),fixture('1.3.0','crash'));
    const state={...update,source:undefined,phase:'testing',sequence:0,previousSha256:supervisor.digest(fixture('1.2.0')),protected:await supervisor.snapshot(root),baseline:{apps:[{id:'app-1',status:'online'}],proxyError:null}};
    await fs.writeFile(path.join(root,'.agent-updates','state.json'),JSON.stringify(state));claimed=true;
  }
  const runner=path.join(root,'runner.cjs');
  // Exercise real IPC/process exit on both Windows and Linux. Parent talks to a
  // local mock control-plane server, never the production Manager.
  const control=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);res.setHeader('Content-Type','application/json');
    if(req.url==='/update-claim'){await until(async()=>!!await supervisor.readJson(path.join(root,'application-runtime.json')));originalApp??=await supervisor.readJson(path.join(root,'application-runtime.json'));claimed=true;res.end(JSON.stringify({update:acked?null:update}));}
    else if(req.url==='/update-report'){originalApp??=await supervisor.readJson(path.join(root,'application-runtime.json'));reports.push(body);if(reportFailures-->0){res.statusCode=503;res.end('{}');}else{acked=true;res.end('{"ok":true}');}}
    else {res.statusCode=404;res.end('{}');}
  });
  await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>control.close(resolve)));
  await fs.writeFile(runner,`require(${JSON.stringify(path.resolve(__dirname,'../scripts/manager-agent-supervisor.cjs'))}).supervise(${JSON.stringify(root)},{pollMs:80,healthMs:1400,stableMs:150,request:async(_c,a,b)=>{const r=await fetch('http://127.0.0.1:${control.address().port}/'+a,{method:'POST',body:JSON.stringify(b)});if(!r.ok)throw new Error('Control plane temporarily offline');return r.json();}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  const child=spawn(process.execPath,[runner],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  t.after(async()=>{
    // Windows signals terminate Node immediately, which also tests orphan-child
    // disconnect handling. Never use taskkill /T or touch a shared service.
    child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,5000).catch(()=>{});
    await until(async()=>!await fs.stat(path.join(root,'agent.lock')).catch(()=>null),5000).catch(()=>{});
    const app=await supervisor.readJson(path.join(root,'application-runtime.json'));if(app){try{process.kill(app.pid);}catch{}}
    await fs.rm(root,{recursive:true,force:true});
  });
  await until(()=>acked,15000).catch(error=>{throw new Error(error.message+'\n'+output);});
  for(const [name,bytes]of Object.entries(protectedFiles))assert.equal(await fs.readFile(path.join(root,name),'utf8'),bytes,name);
  assert.deepEqual(await supervisor.readJson(path.join(root,'application-runtime.json')),originalApp,'The original application process must not be replaced');
  assert.equal(await (await fetch(`http://127.0.0.1:${originalApp.port}`)).text(),'application healthy');
  return {root,update,reports,claimed,child,output};
}
test('real supervisor updates only the agent and preserves enrollment, app files, certificates and live application',async t=>{
  const h=await harness(t,'good');assert.equal(h.reports.at(-1).status,'success');assert.equal(await fs.readFile(path.join(h.root,'manager-agent.cjs'),'utf8'),h.update.source);
});
for(const behavior of ['crash','silent','bad-app'])test(`automatic rollback after candidate ${behavior}`,async t=>{
  const h=await harness(t,behavior);assert.equal(h.reports.at(-1).status,'rolled_back');assert.equal(await fs.readFile(path.join(h.root,'manager-agent.cjs'),'utf8'),fixture('1.2.0'));
});
test('a corrupt package fails without activating or replacing the installed agent',async t=>{
  const h=await harness(t,'good',{corrupt:true});assert.equal(h.reports.at(-1).status,'failed');assert.equal(await fs.readFile(path.join(h.root,'manager-agent.cjs'),'utf8'),fixture('1.2.0'));
});
test('durable result retries after a network outage without reinstalling',async t=>{
  const h=await harness(t,'good',{reportFailures:2});assert.equal(h.reports.length,3);assert.deepEqual(h.reports.map(r=>r.sequence),[1,2,3]);assert.equal(h.reports.at(-1).status,'success');
});
test('restart during activation restores the verified previous agent before starting it',async t=>{
  const h=await harness(t,'good',{crashState:true});assert.equal(h.reports.at(-1).status,'rolled_back');assert.equal(await fs.readFile(path.join(h.root,'manager-agent.cjs'),'utf8'),fixture('1.2.0'));
});
test('path traversal and linked recovery directories cannot target other files',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-agent-path-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await assert.rejects(supervisor.safePath(root,'..','outside'));
  await fs.mkdir(path.join(root,'actual'));
  await fs.symlink(path.join(root,'actual'),path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(supervisor.safePath(root,'linked','agent.json'),/symbolic|junction/);
});
