#!/usr/bin/env node
'use strict';

// Stable, dependency-free recovery process. The service runs THIS file; updates
// replace only manager-agent.cjs. Never restart the service, PM2, Caddy or an app.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const PROTOCOL = 1;
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const terminal = phase => ['success','rolled_back','failed'].includes(phase);
async function readJson(file, fallback=null) { try { return JSON.parse(await fs.readFile(file,'utf8')); } catch(error) { if(error.code==='ENOENT')return fallback; throw error; } }
async function syncDirectory(directory) {
  if(process.platform==='win32')return;
  const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
async function writeExclusive(file,bytes) {
  const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await syncDirectory(path.dirname(file));
}
async function atomic(file, bytes) {
  const tmp=file+'.'+randomBytes(8).toString('hex')+'.tmp';
  await writeExclusive(tmp,bytes);
  await fs.rename(tmp,file);
  await syncDirectory(path.dirname(file));
}
async function save(file, value) { await atomic(file,JSON.stringify(value,null,2)); }
async function safePath(root,...parts) {
  const file=path.resolve(root,...parts), relative=path.relative(root,file);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Update path escaped its dedicated directory');
  let cursor=root;
  for(const part of relative.split(path.sep)) {
    cursor=path.join(cursor,part);
    const stat=await fs.lstat(cursor).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(stat?.isSymbolicLink())throw new Error('Update paths cannot contain symbolic links or junctions');
  }
  return file;
}
function newer(a,b) {
  if(!VERSION.test(a)||!VERSION.test(b))return false;
  const x=a.split('.').map(Number),y=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];
  return false;
}
function validateUpdate(update, installed) {
  if(!update||!ID.test(update.id)||update.supervisorProtocol!==PROTOCOL||update.fromVersion!==installed||!newer(update.version,installed)||
    !/^[A-Za-z0-9_-]{43}$/.test(update.claimToken)||!(/^[a-f0-9]{64}$/).test(update.sha256)||typeof update.source!=='string'||Buffer.byteLength(update.source)>2_000_000||digest(update.source)!==update.sha256)throw new Error('Agent update identity, version or checksum is invalid');
}
async function api(config,action,body) {
  const origin=new URL(config.manager);
  if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname))))throw new Error('Agent Manager address must be a trusted HTTPS origin');
  const response=await fetch(`${origin.origin}/api/server-agent/${action}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.agentToken}`},body:JSON.stringify(body)});
  // Bound the package response before parsing, including chunked responses.
  const reader=response.body.getReader(); let size=0; const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_100_000){await reader.cancel();throw new Error('Agent update response is too large');}chunks.push(value);}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Manager returned an invalid update response');}
  if(!response.ok)throw new Error(`Manager update request returned HTTP ${response.status}`);
  return result;
}
async function inspectCandidate(file) {
  const command=args=>new Promise((resolve,reject)=>{
    let output='',done=false;
    const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(output);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('Candidate validation timed out'));},10000);
    const append=chunk=>{output+=chunk;if(output.length>16384){child.kill();finish(new Error('Invalid candidate output'));}};
    child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',finish);child.on('exit',code=>finish(code===0?null:new Error('Candidate validation failed')));
  });
  await command(['--check',file]);
  const metadata=JSON.parse(await command([file,'version']));
  if(metadata.protocol!==1||metadata.supervisorProtocol!==PROTOCOL||!VERSION.test(metadata.version))throw new Error('Candidate requires a different supervisor protocol');
  return metadata;
}
async function snapshot(root) {
  const result={};
  for(const name of ['agent.json','apps.json','Caddyfile']) {
    const file=await safePath(root,name);
    result[name]=await fs.readFile(file).then(digest).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
  }
  return result;
}
function appsHealthy(before,after) {
  if(!before||!after)return false;
  if(!before.proxyError&&after.proxyError)return false;
  return before.apps.every(app=>after.apps.some(next=>next.id===app.id&&next.status===app.status));
}
async function acquire(file) {
  try{await fs.writeFile(file,String(process.pid),{flag:'wx',mode:0o600});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(await fs.readFile(file,'utf8'));
    if(!Number.isSafeInteger(pid)||pid<1)throw new Error('Inspect the invalid supervisor lock before starting');
    try{process.kill(pid,0);throw new Error('An agent supervisor is already running');}catch(e){if(e.code!=='ESRCH')throw e;}
    await fs.unlink(file);await fs.writeFile(file,String(process.pid),{flag:'wx',mode:0o600});
  }
}
async function supervise(root, options={}) {
  if(!path.isAbsolute(root)||path.resolve(root)===path.parse(root).root)throw new Error('Use the existing dedicated absolute agent data directory');
  if((await fs.lstat(root)).isSymbolicLink())throw new Error('Agent root cannot be a symbolic link');
  root=await fs.realpath(root);
  const agent=await safePath(root,'manager-agent.cjs');
  const directory=await safePath(root,'.agent-updates');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stateFile=await safePath(root,'.agent-updates','state.json');
  const lock=await safePath(root,'.agent-updates','supervisor.lock');
  const config=await readJson(await safePath(root,'agent.json'));
  if(!config?.enrolled)throw new Error('Keep and use the existing enrolled agent.json');
  await acquire(lock);
  let state=await readJson(stateFile),worker=null,stopped=false;
  const pollMs=options.pollMs||5000,healthMs=options.healthMs||90000,stableMs=options.stableMs??15000;
  const request=options.request||api;
  const persist=()=>save(stateFile,state);
  const log=message=>console.error(`[agent supervisor] ${String(message).split(config.agentToken).join('[redacted]')}`);
  const onStop=()=>{stopped=true;};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  async function spawnWorker() {
    // A supervisor crash disconnects its child. Let that child finish shutting
    // down; never kill a PID from a stale file (it may have been reused).
    const end=Date.now()+45000;
    while(true) {
      const pid=Number(await fs.readFile(await safePath(root,'agent.lock'),'utf8').catch(error=>{if(error.code!=='ENOENT')throw error;return '';}));
      let alive=false;try{if(Number.isSafeInteger(pid)&&pid>0){process.kill(pid,0);alive=true;}}catch(error){if(error.code!=='ESRCH')throw error;}
      if(!alive)break;
      if(Date.now()>end)throw new Error('Another agent still owns this directory; wait for it to stop');
      await delay(200);
    }
    const child=spawn(process.execPath,[agent,'run','--root',root],{env:{...process.env,MANAGER_AGENT_SUPERVISOR:'1'},windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});
    const instance={child,idle:false,heartbeat:null,exited:false,error:null};worker=instance;
    child.on('error',error=>{instance.error=error;instance.exited=true;});
    child.on('exit',()=>{instance.exited=true;});
    child.on('message',message=>{
      if(!message||typeof message!=='object')return;
      if(message.type==='idle')instance.idle=message.idle===true;
      if(message.type==='heartbeat'&&VERSION.test(message.version)&&message.metrics&&Array.isArray(message.metrics.apps))instance.heartbeat={...message,received:Date.now()};
    });
    return instance;
  }
  async function stopWorker(force=false) {
    if(!worker||worker.exited)return;
    const instance=worker;
    if(instance.child.connected)instance.child.send({type:'stop'},()=>{});
    const end=Date.now()+30000;
    while(!instance.exited&&Date.now()<end)await delay(100);
    if(!instance.exited&&force){instance.child.kill('SIGKILL');while(!instance.exited&&Date.now()<end+5000)await delay(100);}
    if(!instance.exited)throw new Error('Agent did not stop safely');
  }
  async function confirmed(version, baseline) {
    const end=Date.now()+healthMs;
    let firstHealthy=null;
    while(Date.now()<end) {
      if(worker.exited)throw new Error('Agent exited before its health check completed');
      const pulse=worker.heartbeat;
      if(worker.idle&&pulse?.version===version&&Date.now()-pulse.received<30000&&(!baseline||appsHealthy(baseline,pulse.metrics))) {
        firstHealthy??=pulse.received;
        if(pulse.received-firstHealthy>=stableMs)return;
      } else firstHealthy=null;
      await delay(100);
    }
    throw new Error('Agent did not reconnect with healthy application state in time');
  }
  async function restore() {
    await stopWorker(true);
    const backup=await fs.readFile(await safePath(root,'.agent-updates',state.id,'previous.cjs'));
    if(digest(backup)!==state.previousSha256)throw new Error('Previous agent checksum failed; manual recovery required');
    state.phase='restoring';await persist();
    await atomic(agent,backup);
    state.restored=true;await persist();
    await spawnWorker();await confirmed(state.fromVersion,state.baseline);
    if(JSON.stringify(await snapshot(root))!==JSON.stringify(state.protected))throw new Error('Protected enrollment or application configuration changed; inspect locally');
    state.phase='rolled_back';await persist();
  }
  async function report() {
    if(!state||state.reported)return;
    if(!terminal(state.phase)&&state.phase!=='recovery_required')return;
    if(['success','rolled_back'].includes(state.phase)) {
      const expected=state.phase==='success'?state.version:state.fromVersion;
      if(worker?.heartbeat?.version!==expected||Date.now()-worker.heartbeat.received>30000)return;
    }
    state.sequence=(state.sequence||0)+1;await persist();
    await request(config,'update-report',{id:state.id,claimToken:state.claimToken,sequence:state.sequence,status:state.phase});
    if(state.phase!=='recovery_required'){state.reported=true;await persist();}
  }
  async function apply(update) {
    // Invalid packages still receive a durable failure report, without stopping the agent.
    if(!update||!ID.test(update.id)||!/^[A-Za-z0-9_-]{43}$/.test(update.claimToken))throw new Error('Invalid update claim identity');
    try{validateUpdate(update,worker.heartbeat.version);}catch(error){
      state={id:update.id,claimToken:update.claimToken,phase:'failed',sequence:0,reported:false};await persist();log(error.message);return;
    }
    if(!worker.idle||await readJson(await safePath(root,'current-job.json')))throw new Error('Wait for the current application operation to finish reporting');
    const jobDir=await safePath(root,'.agent-updates',update.id);await fs.mkdir(jobDir,{recursive:true,mode:0o700});
    const previous=await fs.readFile(agent);
    state={id:update.id,claimToken:update.claimToken,version:update.version,fromVersion:update.fromVersion,phase:'preparing',sequence:0,previousSha256:digest(previous),sha256:update.sha256,protected:await snapshot(root),baseline:worker.heartbeat.metrics,reported:false};
    await persist();
    try {
      if((await inspectCandidate(agent)).version!==state.fromVersion)throw new Error('Installed script differs from the running agent');
      await writeExclusive(await safePath(root,'.agent-updates',state.id,'previous.cjs'),previous);
      const candidate=await safePath(root,'.agent-updates',state.id,'candidate.cjs');
      await writeExclusive(candidate,update.source);
      if((await inspectCandidate(candidate)).version!==update.version)throw new Error('Candidate version does not match the offered package');
      if(JSON.stringify(await snapshot(root))!==JSON.stringify(state.protected))throw new Error('Server state changed during update preparation');
      await stopWorker();
      state.phase='activating';await persist(); // Durable BEFORE replacing anything.
      const bytes=await fs.readFile(candidate);if(digest(bytes)!==state.sha256)throw new Error('Candidate checksum changed');
      await atomic(agent,bytes);
      state.phase='testing';await persist();
      await spawnWorker();await confirmed(state.version,state.baseline);
      if(JSON.stringify(await snapshot(root))!==JSON.stringify(state.protected))throw new Error('Protected server state changed');
      state.phase='success';await persist();
    } catch(error) {
      log(error.message);
      if(state.phase==='preparing') { state.phase='failed';await persist();if(worker.exited)await spawnWorker(); }
      else {try{await restore();}catch(recovery){log(recovery.message);state.phase='recovery_required';await persist();}}
    }
  }
  try {
    if(state&&!terminal(state.phase)&&state.phase!=='preparing') {
      if(!ID.test(state.id))throw new Error('Invalid recovery record');
      try{await restore();}catch(error){log(error.message);state.phase='recovery_required';await persist();}
    } else {
      if(state?.phase==='preparing'){state.phase='failed';await persist();}
      await spawnWorker();
    }
    while(!stopped) {
      try {
        if(worker?.exited&&state?.phase!=='recovery_required')await spawnWorker();
        // A network outage can outlast the local rollback health window. Resume
        // confirmation when the restored agent reconnects; never reinstall it.
        if(state?.phase==='recovery_required'&&state.restored&&worker?.heartbeat?.version===state.fromVersion&&appsHealthy(state.baseline,worker.heartbeat.metrics)) {
          await confirmed(state.fromVersion,state.baseline);
          if(JSON.stringify(await snapshot(root))===JSON.stringify(state.protected)){state.phase='rolled_back';await persist();}
        }
        await report();
        if((!state||state.reported)&&worker?.idle&&worker.heartbeat&&Date.now()-worker.heartbeat.received<30000) {
          const {update}=await request(config,'update-claim',{supervisorProtocol:PROTOCOL,version:worker.heartbeat.version});
          if(update)await apply(update);
        }
      } catch(error){log(error.message);}
      await delay(pollMs);
    }
  } finally {
    await stopWorker(false);
    process.off('SIGINT',onStop);process.off('SIGTERM',onStop);
    await fs.unlink(lock).catch(()=>{});
  }
}
module.exports={PROTOCOL,digest,newer,validateUpdate,inspectCandidate,snapshot,appsHealthy,safePath,atomic,readJson,supervise,api};
if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--root')throw new Error('Usage: node manager-agent-supervisor.cjs --root <existing agent directory>');
  supervise(args[1]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
