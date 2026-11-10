'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),{fork}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {lab,pause}=require('./fixtures/live-agent-lab.cjs'),{agentBundle}=require('../scripts/agent-bundle.cjs');

test('packaged agent starts, reports healthy IPC heartbeats and stops in an isolated live environment',{skip:!process.env.TEST_PM2_PACKAGE_ROOT||!process.env.TEST_CADDY,timeout:120000},async t=>{
  let child,h;
  t.after(async()=>{
    if(child?.connected)child.send({type:'stop'});
    if(child)for(let i=0;i<150&&child.exitCode===null&&child.signalCode===null;i++)await pause(100);
    if(child&&child.exitCode===null&&child.signalCode===null)child.kill();
    // A broken packaged preload must not prevent the lab from stopping its
    // private daemon. Restore only this fixture's known-good preload first.
    if(h)await require('../scripts/manager-agent.cjs').privatePm2Environment(h.root,path.resolve(process.env.TEST_PM2_PACKAGE_ROOT,'bin/pm2'));
  });
  h=await lab(t);const pulses=[],messages=[];
  const control=http.createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
    if(req.url==='/api/server-agent/heartbeat')pulses.push(body);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/claim')?{job:null,protocol:1}:{ok:true}));
  });
  await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{control.close(resolve);control.closeAllConnections();}));
  await fs.writeFile(path.join(h.root,'agent.json'),JSON.stringify({enrolled:true,manager:'http://127.0.0.1:'+control.address().port,serverId:randomUUID(),agentToken:'disposable-startup-token'}));
  await fs.writeFile(path.join(h.root,'apps.json'),'{}');
  await fs.writeFile(path.join(h.root,'tool-paths.json'),JSON.stringify({node:process.execPath,git:h.git,caddy:h.tools.caddy,pm2:path.resolve(process.env.TEST_PM2_PACKAGE_ROOT,'bin/pm2')}));
  const candidate=path.join(h.root,'manager-agent.cjs');
  const source=process.env.TEST_AGENT_BUNDLE_FILE?await fs.readFile(process.env.TEST_AGENT_BUNDLE_FILE):process.env.TEST_PRODUCTION_BUILD==='1'?await require('./fixtures/production-agent-bundle.cjs')():await agentBundle();
  await fs.writeFile(candidate,source);
  child=fork(candidate,['run','--root',h.root],{windowsHide:true,env:{...process.env,MANAGER_AGENT_SUPERVISOR:'1'},stdio:['ignore','pipe','pipe','ipc']});
  let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);child.on('message',message=>messages.push(message));
  for(let i=0;i<700;i++){if(child.exitCode!==null||child.signalCode!==null)assert.fail('Packaged agent exited: '+output);if(pulses.length>=2&&messages.filter(m=>m.type==='heartbeat').length>=2&&messages.some(m=>m.type==='idle'&&m.idle))break;await pause(100);}
  assert.ok(pulses.length>=2,'Missing control-plane heartbeats: '+output);
  assert.ok(messages.filter(m=>m.type==='heartbeat').length>=2,'Missing supervisor heartbeats: '+output);
  assert.ok(messages.some(m=>m.type==='idle'&&m.idle),'Missing supervisor idle state: '+output);
  assert.equal(pulses.at(-1).metrics.proxyError,null);
  assert.ok(pulses.at(-1).metrics.capabilities.includes('database-browser-v1'));
  child.send({type:'stop'});
  for(let i=0;i<200&&child.exitCode===null;i++)await pause(100);
  assert.equal(child.exitCode,0,'Packaged agent did not stop cleanly: '+output);
  assert.equal(await fs.readFile(h.configPath,'utf8'),h.source);
});
