// This worker is copied outside the installation with its own pg/dotenv runtime.
// It never runs package scripts, updates PM2 itself, or restarts hosted applications.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const https=require('node:https');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const S=require('./manager-update-state.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(exe,args,env,timeout=120000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',error='';
    child.stdout.on('data',b=>{if(output.length<1024*1024) output+=b});
    child.stderr.on('data',b=>{if(error.length<4096) error+=b});
    const timer=setTimeout(()=>{child.kill();reject(new Error(path.basename(exe)+' exceeded its timeout'))},timeout);
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve(output);else{const e=new Error(path.basename(exe)+' failed (exit '+code+'). Inspect the protected diagnostics.log.');e.diagnostic=error;reject(e)}});
  });
}
function environment(c) {
  const env={...process.env,PM2_HOME:c.pm2Home};
  delete env.MANAGER_PREVIEW;
  return env;
}
function pm2(c,verb,name) {
  if(!['manager','manager-phpmyadmin','manager-pgweb'].includes(name)) throw new Error('Refusing to change an unrelated process');
  return command(c.nodeExe,[path.join(c.pm2PackageRoot,'bin/pm2'),verb,name],environment(c));
}
async function processes(c) {
  // Read-only RPC: unlike the CLI, this cannot accidentally spawn a second daemon.
  const req=createRequire(path.join(c.pm2PackageRoot,'package.json'));
  return new Promise((resolve,reject)=>{
    const socket=req('pm2-axon').socket('req'),client=new (req('pm2-axon-rpc').Client)(socket);
    let done=false;
    const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);socket.close();e?reject(e):resolve(v)};
    const timer=setTimeout(()=>finish(new Error('The registered PM2 daemon is unavailable')),5000);
    socket.on('error',e=>finish(e));
    socket.once('connect',()=>client.call('getMonitorData',{},finish));
    socket.connect(process.platform==='win32'?'\\\\.\\pipe\\rpc.sock':path.join(c.pm2Home,'rpc.sock'));
  });
}
function connection(c) {
  const env=require('dotenv').parse(fs.readFileSync(path.join(c.managerRoot,'.env.local')));
  return {env, options:env.DATABASE_URL?{connectionString:env.DATABASE_URL}:{host:env.DATABASE_HOST||'127.0.0.1',port:Number(env.DATABASE_PORT||5432),database:env.DATABASE_NAME,user:env.DATABASE_USER,password:env.DATABASE_PASSWORD}};
}
const busyTables=[['deployments','status',['queued','running']],['runtime_jobs','status',['queued','running']],['data_migration_jobs','status',['queued','running','validating']],['database_moves','status',['running']],['database_renames','status',['running']],['cron_jobs','last_status',['running']],['backup_schedules','last_status',['running']],['data_service_backup_schedules','last_status',['running']],['remote_jobs','status',['queued','running']]];
async function assertIdle(c) {
  const {Client}=require('pg'); const client=new Client({...connection(c).options,connectionTimeoutMillis:5000});
  await client.connect();
  try {
    for(const [table,column,statuses] of busyTables) {
      const exists=(await client.query('select to_regclass($1) as name',[table])).rows[0].name;
      if(exists && (await client.query(`select 1 from ${table} where ${column}::text=any($1::text[]) limit 1`,[statuses])).rowCount) throw new Error('Wait for active '+table.replaceAll('_',' ')+' before updating Manager');
    }
    const operations=path.join(c.stateRoot,'operations');
    if(fs.existsSync(operations) && fs.readdirSync(operations).length) throw new Error('A server setup or database operation is still active');
  } finally { await client.end(); }
}
async function backup(c,dir,state) {
  const target=S.inside(dir,'backup');await fsp.mkdir(target,{recursive:true});
  await fsp.copyFile(path.join(c.managerRoot,'.env.local'),path.join(target,'.env.local'));
  for(const name of ['dump.pm2','dump.pm2.bak']) if(fs.existsSync(path.join(c.pm2Home,name))) await fsp.copyFile(path.join(c.pm2Home,name),path.join(target,name));
  if(c.caddyConfig && fs.existsSync(c.caddyConfig)) await fsp.copyFile(c.caddyConfig,path.join(target,'Caddyfile'));
  const {env,options}=connection(c);
  let db=options;
  if(options.connectionString) {
    const u=new URL(options.connectionString);
    db={host:u.hostname,port:Number(u.port||5432),database:decodeURIComponent(u.pathname.slice(1)),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};
  }
  if(!db.database || !db.user) throw new Error('Manager database backup connection is incomplete');
  const pgEnv={...environment(c),PGHOST:db.host,PGPORT:String(db.port),PGDATABASE:db.database,PGUSER:db.user,PGPASSWORD:db.password||'',PGCONNECT_TIMEOUT:'10'};
  if(env.DATABASE_URL) {const mode=new URL(env.DATABASE_URL).searchParams.get('sslmode');if(mode)pgEnv.PGSSLMODE=mode;}
  const dump=path.join(target,'manager.pgdump');
  await command(c.pgDump,['--format=custom','--no-owner','--no-acl','--file',dump],pgEnv,10*60_000);
  const restore=path.join(path.dirname(c.pgDump),process.platform==='win32'?'pg_restore.exe':'pg_restore');
  await command(restore,['--list',dump],pgEnv);
  if((await fsp.stat(dump)).size<100) throw new Error('Manager database backup is empty');
  state.backupCreated=true;
  S.save(dir,state,undefined,'Manager database, settings and process configuration backed up');
}
async function health(c,version,legacy=false) {
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline) {
    try {
      const rows=await processes(c);
      const manager=rows.find(r=>r.name==='manager');
      if(manager?.pm2_env?.status!=='online') throw new Error('Manager is not online');
      const nonce=crypto.randomUUID();
      const response=await fetch(`http://127.0.0.1:${c.port}${legacy?'/login':'/api/manager-health'}?nonce=${nonce}`,{signal:AbortSignal.timeout(5000),redirect:'error',cache:'no-store'});
      if(!response.ok) throw new Error('Readiness check failed');
      if(!legacy) {const body=await response.json();if(!body.ready || body.version!==version || body.nonce!==nonce)throw new Error('Wrong release responded');}
      if(c.managerUrl) await new Promise((resolve,reject)=>{
        const ca=c.caCertificate?fs.readFileSync(c.caCertificate):undefined;
        const req=https.get(new URL('/login',c.managerUrl),{ca,lookup:(_host,opts,done)=>opts.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4)},response=>{
          response.resume();response.statusCode===200?resolve():reject(new Error('HTTPS route is not ready'));
        });
        req.setTimeout(5000,()=>req.destroy(new Error('HTTPS readiness timeout')));req.once('error',reject);
      });
      return;
    } catch {await sleep(2000);}
  }
  throw new Error('Manager did not pass its process, database and HTTP readiness checks');
}
async function integrity(dir) {
  const entries=S.json(S.inside(dir,'inventory.json'));
  const actual=[];
  function walk(folder,prefix='') {for(const e of fs.readdirSync(folder,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())walk(path.join(folder,e.name),rel+'/');else actual.push(rel);}}
  walk(S.inside(dir,'stage'));
  if(actual.length!==Object.keys(entries).length || actual.some(name=>!Object.hasOwn(entries,name)))throw new Error('Staged release file list was changed');
  const queue=Object.entries(entries);let next=0;
  // Bound open files while avoiding one filesystem round trip at a time on
  // Windows installations with tens of thousands of dependency files.
  await Promise.all(Array.from({length:8},async()=>{while(next<queue.length){
    const [name,expected]=queue[next++];
    const file=S.inside(S.inside(dir,'stage'),name);
    const stat=await fsp.lstat(file);if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Staged release was changed');
    const hash=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))hash.update(b);
    if(hash.digest('hex')!==expected)throw new Error('Staged release integrity check failed');
  }}));
  S.assertNoLinks(S.inside(dir,'stage'),fs.readdirSync(S.inside(dir,'stage')));
}
async function recover(c,dir,state,filesOnly=false,services={pm2,health}) {
  S.save(dir,state,'rolling_back','Recovery started');
  if(!filesOnly) for(const name of state.stopped||['manager']) await services.pm2(c,'stop',name);
  S.restore(c,dir,state);
  for(const file of ['manager-update-worker.cjs','manager-update-state.cjs']) {
    const saved=S.inside(dir,'backup/runner/'+file);
    if(fs.existsSync(saved)) {
      const target=S.inside(c.stateRoot,'runner/'+file),temp=target+'.restore.tmp';
      fs.copyFileSync(saved,temp);fs.renameSync(temp,target);
    }
  }
  if(filesOnly) return;
  for(const name of state.stopped||['manager']) await services.pm2(c,'restart',name);
  await services.health(c,state.fromVersion,state.legacyHealth);
  S.save(dir,state,'rolled_back','Previous release restored and healthy. Database backup retained; compatible additive schema changes are preserved.');
  await fsp.rm(path.join(c.managerRoot,'.manager-maintenance.json'),{force:true});
}
async function refreshRunner(c,dir) {
  for(const file of ['manager-update-state.cjs','manager-update-worker.cjs']) {
    const target=S.inside(c.stateRoot,'runner/'+file),saved=S.inside(dir,'backup/runner/'+file);
    fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(target,saved);
    const temp=target+'.next.tmp';fs.copyFileSync(S.inside(c.managerRoot,'scripts/'+file),temp);fs.renameSync(temp,target);
  }
}
async function apply(c,dir,state,services={processes,integrity,assertIdle,sleep,backup,pm2,health,refreshRunner}) {
  const rows=await services.processes(c), manager=rows.filter(r=>r.name==='manager');
  if(manager.length!==1 || path.resolve(manager[0].pm2_env.pm_cwd).toLowerCase()!==path.resolve(c.managerRoot).toLowerCase() || path.resolve(manager[0].pm2_env.pm_exec_path).toLowerCase()!==path.resolve(c.managerRoot,'node_modules/next/dist/bin/next').toLowerCase() || path.resolve(manager[0].pm2_env.PM2_HOME).toLowerCase()!==path.resolve(c.pm2Home).toLowerCase()) throw new Error('Registered Manager process does not match this installation');
  if(manager[0].pm2_env.status!=='online')throw new Error('Manager must be online before installing an update');
  S.save(dir,state,undefined,'Checking staged files before stopping Manager');
  await services.integrity(dir);
  const disk=await fsp.statfs(c.stateRoot);if(disk.bavail*disk.bsize<2*1024**3)throw new Error('Keep at least 2 GB free for recovery and database backup');
  await services.assertIdle(c);
  S.atomic(path.join(c.managerRoot,'.manager-maintenance.json'),{id:state.id,since:new Date().toISOString()});
  S.save(dir,state,'draining','Pausing new work and waiting for current operations');
  await services.sleep(15_000);
  await services.assertIdle(c);
  // Persist the original process list before stopping anything, including crash recovery.
  state.stopped=rows.filter(r=>['manager','manager-phpmyadmin','manager-pgweb'].includes(r.name) && r.pm2_env.status==='online').map(r=>r.name);
  S.save(dir,state,'stopping','Stopping Manager for a consistent backup');
  for(const name of state.stopped) await services.pm2(c,'stop',name);
  await services.assertIdle(c);
  await services.backup(c,dir,state);
  S.activate(c,dir,state);
  S.save(dir,state,'checking','Starting Manager and checking the installed release');
  for(const name of state.stopped) await services.pm2(c,'restart',name);
  await services.health(c,state.version);
  if(services.refreshRunner)await services.refreshRunner(c,dir);
  S.save(dir,state,'succeeded','Update complete. The previous release and database backup are retained for recovery.');
  await fsp.rm(path.join(c.managerRoot,'.manager-maintenance.json'),{force:true});
}
async function main(configPath,mode='run') {
  const c=S.json(configPath);S.config(c.managerRoot);
  const job=S.currentJob(c); if(!job) return;
  const {dir,state}=job;
  if(S.TERMINAL.includes(state.phase)) {
    const marker=path.join(c.managerRoot,'.manager-maintenance.json');
    if(fs.existsSync(marker) && S.json(marker).id===state.id && ['succeeded','rolled_back'].includes(state.phase)) fs.unlinkSync(marker);
    return;
  }
  if(['preparing','ready'].includes(state.phase)) return;
  const lock=S.inside(c.stateRoot,'worker.lock');
  let fd;
  try {fd=fs.openSync(lock,'wx');} catch(error) {
    if(error.code!=='EEXIST')throw error;
    const old=S.json(lock);let alive=false;
    // A PID can be reused after reboot. Never mistake that unrelated process for
    // the updater which wrote this lock during the previous boot.
    if(old.at>Date.now()-os.uptime()*1000-5000) {
      try{process.kill(old.pid,0);alive=true}catch(e){if(e.code!=='ESRCH')throw e}
      if(alive && process.platform==='win32' && Number.isSafeInteger(old.pid) && old.pid>0) {
        const born=Number((await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[DateTimeOffset]::new((Get-Process -Id ${old.pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],environment(c),10000)).trim());
        if(Number.isFinite(born)&&born>old.at+1000)alive=false;
      }
    }
    if(alive)return;
    fs.unlinkSync(lock);fd=fs.openSync(lock,'wx');
  }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:Date.now()}));fs.closeSync(fd);
  try {
    if(state.phase==='queued' && mode==='run') {
      try {await apply(c,dir,state);} catch(error) {
        if(error.diagnostic)fs.appendFileSync(S.inside(dir,'diagnostics.log'),new Date().toISOString()+' '+error.message+'\n'+error.diagnostic+'\n',{mode:0o600});
        S.save(dir,state,undefined,error.message);
        if(state.stopped) await recover(c,dir,state);
        else {S.save(dir,state,'failed','Update stopped before activation. '+error.message);await fsp.rm(path.join(c.managerRoot,'.manager-maintenance.json'),{force:true});}
      }
    } else {
      if(state.manualRollback && !state.recoveryStarted && mode!=='files-only') {
        await sleep(15_000);
        try {await assertIdle(c);}catch(error){
          S.save(dir,state,'succeeded','Rollback deferred: '+error.message);
          await fsp.rm(path.join(c.managerRoot,'.manager-maintenance.json'),{force:true});return;
        }
        state.stopped=(await processes(c)).filter(r=>['manager','manager-phpmyadmin','manager-pgweb'].includes(r.name)&&r.pm2_env.status==='online').map(r=>r.name);
        if(!state.stopped.includes('manager'))state.stopped.unshift('manager');
        state.recoveryStarted=true;S.save(dir,state,'rolling_back','Rollback preflight passed');
      }
      await recover(c,dir,state,mode==='files-only');
    }
  } catch(error) {S.save(dir,state,'recovery_failed','Recovery needs attention: '+error.message);throw error;}
  finally {fs.unlinkSync(lock);}
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main,apply,recover,command,processes,health,assertIdle,busyTables,integrity,backup};
