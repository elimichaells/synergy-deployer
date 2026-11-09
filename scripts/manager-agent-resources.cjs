'use strict';
// Runs only inside the selected agent. Never imports Manager's database, host
// process manager or host paths. All application changes use its private PM2.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readDiagnostics, classifyReadiness } = require('./health-diagnostics.cjs');
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const CAPABILITY = 'remote-resources-v1';
const MB = 1024 ** 2;
const cache = new Map();
const gateways=new Map();
const busyRoots=new Set();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const diagnostics=Object.fromEntries([{check:'configuration',issues:['DATABASE_URL']},{check:'configuration'},{check:'database'},{check:'database',issues:['authentication']},{check:'database',issues:['permissions']},{check:'database',issues:['migrations']},{ready:false}].map(body=>{const d=classifyReadiness(body);return[d.issueCode,d];}));
const sanitizeDiagnostics=value=>diagnostics[value?.issueCode];
async function processMemory(h) {
  if (process.platform === 'win32') {
    // Use the same OS commit counters as the host. The formatted performance
    // provider can take tens of seconds to initialize on a fresh Windows VM.
    const script = "$ErrorActionPreference='Stop';$m=Get-CimInstance Win32_OperatingSystem;$p=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,PrivatePageCount,WorkingSetSize,CreationDate | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='ppid';e={[int]$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='privateBytes';e={[double]$_.PrivatePageCount}},@{n='workingBytes';e={[double]$_.WorkingSetSize}},@{n='started';e={if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}});$f=@(Get-CimInstance Win32_PageFileUsage);@{processes=$p;commitMb=([double]$m.TotalVirtualMemorySize-[double]$m.FreeVirtualMemory)/1024;commitLimitMb=[double]$m.TotalVirtualMemorySize/1024;pageFileMb=[double](($f|Measure-Object AllocatedBaseSize -Sum).Sum);pageFileUsedMb=[double](($f|Measure-Object CurrentUsage -Sum).Sum)}|ConvertTo-Json -Depth 5 -Compress";
    return JSON.parse(await h.run('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {timeout:45000,stdoutOnly:true}));
  }
  const processes=[];
  for (const pid of (await fs.readdir('/proc')).filter(n=>/^\d+$/.test(n)).slice(0,4000)) {
    try {
      const s=await fs.readFile(`/proc/${pid}/status`,'utf8'),stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');
      const field=name=>Number(s.match(new RegExp(`^${name}:\\s+(\\d+)`,'m'))?.[1]||0);
      // RSS is the portable Linux measure. Never return command lines or env.
      const rss=field('VmRSS')*1024;
      processes.push({pid:Number(pid),ppid:field('PPid'),name:s.match(/^Name:\s+(.+)$/m)?.[1]||'unknown',privateBytes:rss,workingBytes:rss,started:Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19])});
    } catch {} // Processes can exit during collection.
  }
  const mem=await fs.readFile('/proc/meminfo','utf8');
  const value=name=>Number(mem.match(new RegExp(`^${name}:\\s+(\\d+)`,'m'))?.[1]||0)/1024;
  return {processes,commitMb:null,commitLimitMb:null,pageFileMb:value('SwapTotal'),pageFileUsedMb:value('SwapTotal')-value('SwapFree')};
}
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.min(v,Number.MAX_SAFE_INTEGER):0;
  const text=(v,max=1024)=>typeof v==='string'?v.replace(/[\x00-\x1f]/g,'').slice(0,max):'';
  return {at:text(raw.at,40),root:text(raw.root),error:text(raw.error,500)||null,
    commitMb:raw.commitMb==null?null:num(raw.commitMb),commitLimitMb:raw.commitLimitMb==null?null:num(raw.commitLimitMb),pageFileMb:raw.pageFileMb==null?null:num(raw.pageFileMb),pageFileUsedMb:raw.pageFileUsedMb==null?null:num(raw.pageFileUsedMb),
    processes:(Array.isArray(raw.processes)?raw.processes:[]).slice(0,4000).map(p=>({pid:num(p.pid),ppid:num(p.ppid),name:text(p.name,100),privateBytes:num(p.privateBytes),workingBytes:num(p.workingBytes),started:num(p.started),launcher:p.launcher===true})),
    apps:(Array.isArray(raw.apps)?raw.apps:[]).filter(a=>ID.test(a.id)).slice(0,200).map(a=>({id:a.id,cwd:text(a.cwd),limitMb:a.limitMb==null?null:num(a.limitMb),method:a.method==='direct'?'direct':'runner',direct:a.direct===true,reason:text(a.reason,300),sleepAfterMinutes:a.sleepAfterMinutes==null?null:num(a.sleepAfterMinutes),sleepingSince:text(a.sleepingSince,40)||null,lastActiveAt:text(a.lastActiveAt,40)||null})),
    workers:(Array.isArray(raw.workers)?raw.workers:[]).filter(w=>ID.test(w.id)).slice(0,200).map(w=>({id:w.id,status:text(w.status,30),pid:num(w.pid),memory:num(w.memory),cpu:num(w.cpu),restarts:num(w.restarts),uptime:num(w.uptime)}))};
}
async function telemetry(root, saved, list, h) {
  const prior=cache.get(root);
  if(prior&&Date.now()-prior.time<60000)return prior.value;
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}});
  let memory;try{memory=await processMemory(h);}catch{memory={processes:[],error:'Process memory collection failed. Retry after checking the agent account permissions.'};}
  const apps=[];
  for(const [id,item] of Object.entries(saved)) {
    const launch=await h.readJson(path.join(path.dirname(item.ecosystem),'launch.json'),null);
    const settings=cfg.apps?.[id]||{};
    const direct=launch?await directPlan(launch,h):{ok:false,reason:'Deploy the application to collect its launch configuration'};
    apps.push({id,cwd:launch?.cwd||'',...settings,direct:direct.ok,reason:direct.reason||''});
    const p=list.find(p=>p.name===`manager-remote-${id}`),row=memory.processes.find(p2=>p2.pid===p?.pid);
    if(row&&settings.method!=='direct')row.launcher=true;
  }
  const workers=list.filter(p=>p.name?.startsWith('manager-worker-')).map(p=>({id:p.name.slice(15),status:p.pm2_env?.status||'unknown',pid:p.pid,memory:p.monit?.memory,cpu:p.monit?.cpu,restarts:p.pm2_env?.restart_time,uptime:p.pm2_env?.pm_uptime}));
  const value=sanitize({...memory,root,at:new Date().toISOString(),apps,workers});cache.set(root,{time:Date.now(),value});return value;
}
function invalidate(root){cache.delete(root);}
// A conservative direct start parser: anything requiring shell semantics keeps
// its existing runner. No eval, shell expansion or arbitrary command rewriting.
async function directPlan(launch,h) {
  if(launch.env?.MANAGER_NODE_VERSION)return {ok:false,reason:'A pinned Node version uses its selected runtime through the runner'};
  let command=launch.command.trim();
  if (/^npm(?:\.cmd)? (?:run )?start$/.test(command)) {
    const pkg=await h.readJson(path.join(launch.cwd,'package.json'),{});command=pkg.scripts?.start||'';
  }
  const match=/^node(?:\.exe)?\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?:\s+((?:[a-zA-Z0-9_./=:-]+\s*)*))?$/.exec(command);
  if(!match)return {ok:false,reason:'The start command needs the shell runner'};
  const file=path.resolve(launch.cwd,match[1]||match[2]||match[3]);
  if(!file.startsWith(path.resolve(launch.cwd)+path.sep)||!await fs.stat(file).then(s=>s.isFile()).catch(()=>false))return {ok:false,reason:'The Node entry file is outside the release or missing'};
  const selected=launch.env?.MANAGER_NODE_BINARY;
  return {ok:true,script:file,args:(match[4]||'').trim().split(/\s+/).filter(Boolean),interpreter:selected||process.execPath};
}
function heapOptions(value,limit){const kept=String(value||'').replace(/(?:^|\s)--max-old-space-size(?:=|\s+)\d+/g,'').trim();return [kept,limit?`--max-old-space-size=${Math.max(192,Math.floor(limit*.75))}`:''].filter(Boolean).join(' ');}
async function definition(root,id,ecosystem,launch,settings,h) {
  const app={name:`manager-remote-${id}`,script:path.join(path.dirname(ecosystem),'runner.cjs'),cwd:launch.cwd,interpreter:process.execPath,kill_timeout:10000,shutdown_with_message:true,min_uptime:'10s',max_restarts:10,env:{NODE_ENV:'production'}};
  if(settings.limitMb)app.max_memory_restart=`${settings.limitMb}M`;
  if(settings.method==='direct') {const plan=await directPlan(launch,h);if(!plan.ok)throw Error(plan.reason);Object.assign(app,{script:plan.script,args:plan.args,interpreter:plan.interpreter,env:launch.env});}
  return {apps:[app]};
}
async function applyLaunchSettings(root,id,ecosystem,h) {
  const settings=(await h.readJson(path.join(root,'resources.json'),{apps:{}})).apps?.[id]||{};
  const launchFile=path.join(path.dirname(ecosystem),'launch.json'),launch=await h.readJson(launchFile);
  if(settings.limitMb)launch.env.NODE_OPTIONS=heapOptions(launch.env.NODE_OPTIONS,settings.limitMb);
  await h.atomicJson(launchFile,launch);
  await fs.writeFile(ecosystem,`module.exports=${JSON.stringify(await definition(root,id,ecosystem,launch,settings,h))};\n`,{mode:0o600});
}
async function recover(root,tools,h) {
  const file=path.join(root,'resource-transaction.json'),tx=await h.readJson(file);
  if(!tx)return;
  if(tx.recoveryFailed)throw Error('The previous app settings rollback needs manual review; restore its recorded launch settings before clearing resource-transaction.json');
  const saved=await h.readJson(path.join(root,'apps.json'),{}),item=saved[tx.id];
  if(!ID.test(tx.id)||!item||item.ecosystem!==tx.ecosystem)throw Error('Resource recovery requires manual review; app state changed');
  const ecosystem=await h.contained(root,path.relative(root,tx.ecosystem));
  await fs.writeFile(ecosystem,tx.definition,{mode:0o600});await h.atomicJson(path.join(path.dirname(ecosystem),'launch.json'),tx.launch);
  await h.atomicJson(path.join(root,'resources.json'),tx.settings);
  try {await tools.pm(['delete',`manager-remote-${tx.id}`]).catch(()=>{});await tools.pm(['start',ecosystem]);await h.healthy(item.app);await tools.pm(['save','--force']);}
  catch(error){await h.atomicJson(file,{...tx,recoveryFailed:true});throw error;}
  await fs.unlink(file);invalidate(root);
}
async function appChange(root,input,tools,h) {
  const saved=await h.readJson(path.join(root,'apps.json'),{}),item=saved[input.id];
  if(!ID.test(input.id)||!item)throw Error('Deploy this managed application first');
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}});cfg.apps||={};const previous=JSON.parse(JSON.stringify(cfg));
  const settings={...(cfg.apps[input.id]||{})};
  if(input.action==='memory') {
    const n=input.limitMb;
    if(n!==null&&(!Number.isInteger(n)||n<256||n>os.totalmem()/MB))throw Error('Invalid application memory limit');
    settings.limitMb=n;
  } else if(input.action==='start-method') {
    if(!['direct','runner'].includes(input.method))throw Error('Invalid start method');settings.method=input.method;
  } else throw Error('Unknown app resource operation');
  const ecosystem=await h.contained(root,path.relative(root,item.ecosystem)),launchFile=path.join(path.dirname(ecosystem),'launch.json'),launch=await h.readJson(launchFile);
  const before=await h.processList(tools.pm);const own=before.find(p=>p.name===`manager-remote-${input.id}`);
  if(own?.pm2_env?.status!=='online')throw Error('Start the app and verify it is healthy before changing its launch settings');
  await h.healthy(item.app,5000);
  await h.atomicJson(path.join(root,'resource-transaction.json'),{id:input.id,ecosystem,definition:await fs.readFile(ecosystem,'utf8'),launch,settings:previous});
  cfg.apps[input.id]=settings;
  try{
    if(input.action==='memory')launch.env.NODE_OPTIONS=heapOptions(launch.env.NODE_OPTIONS,input.limitMb);
    await h.atomicJson(launchFile,launch);await h.atomicJson(path.join(root,'resources.json'),cfg);await applyLaunchSettings(root,input.id,ecosystem,h);
    await tools.pm(['delete',own.name]);await tools.pm(['start',ecosystem]);await h.healthy(item.app);await tools.pm(['save','--force']);
    await fs.unlink(path.join(root,'resource-transaction.json'));invalidate(root);return {ok:true,healthy:true,limitMb:settings.limitMb||null,method:settings.method||'runner'};
  }catch(error){await recover(root,tools,h);return {ok:true,healthy:false,restored:true,reason:error.message};}
}
async function ordinary(root,file) {
  const base=path.resolve(root),target=path.resolve(file),rel=path.relative(base,target);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('Cleanup path escapes its managed root');
  for(const part of [base,...rel.split(path.sep).map((_,i,a)=>path.join(base,...a.slice(0,i+1)))]) {
    const stat=await fs.lstat(part);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Cleanup does not follow links or non-directory paths');
    const real=await fs.realpath(part);
    if(path.resolve(real).toLowerCase()!==path.resolve(part).toLowerCase()) {
      const resolved=await fs.stat(real);
      // Windows TEMP can be an 8.3 alias. Accept the same ordinary directory by
      // filesystem identity, after rejecting every reparse point in ancestry.
      if(process.platform!=='win32'||!stat.ino||stat.ino!==resolved.ino||stat.dev!==resolved.dev)throw Error('Cleanup path resolves through a different location');
    }
  }
  return target;
}
async function sizeTree(dir) {
  let bytes=0,count=0;const pending=[dir];
  while(pending.length){const at=pending.pop();for(const entry of await fs.readdir(at,{withFileTypes:true})){if(++count>2000000)throw Error('Folder is too large for a bounded cleanup scan');const file=path.join(at,entry.name);const s=await fs.lstat(file);if(s.isSymbolicLink())throw Error('Folder contains a link and is protected');if(s.isDirectory())pending.push(file);else if(s.isFile())bytes+=s.size;else throw Error('Folder contains a special file and is protected');}}
  return bytes;
}
async function diskPlan(root,input,tools,h) {
  const saved=await h.readJson(path.join(root,'apps.json'),{}),workers=await h.readJson(path.join(root,'workers.json'),{}),list=await h.processList(tools.pm);
  const journal=await h.readJson(path.join(root,'current-job.json'));
  const refs=[...list.flatMap(p=>[p.pm2_env?.pm_cwd,p.pm2_env?.pm_exec_path]),...Object.values(workers).map(w=>w.workingDirectory),...Object.values(saved).map(a=>a.ecosystem),journal?.activation?.previous?.ecosystem,...(input.protectedPaths||[])].filter(p=>typeof p==='string');
  for(const item of Object.values(saved)){const launch=await h.readJson(path.join(path.dirname(item.ecosystem),'launch.json'));if(launch?.cwd)refs.push(launch.cwd);}
  const report={projects:[],removed:[],warnings:[],eligibleBytes:0,retainedBytes:0,removedBytes:0};let reportBytes=0;
  const records=Array.isArray(input.releases)?input.releases:[];
  for(const app of input.apps||[]) {
    if(!ID.test(app.id))throw Error('Invalid cleanup application');
    const project={projectId:app.id,projectName:app.name,entries:[],warnings:[]};report.projects.push(project);
    const history=records.filter(r=>r.app_id===app.id&&ID.test(r.id));
    const newest=history.filter(r=>r.status==='success').sort((a,b)=>Date.parse(b.finished_at)-Date.parse(a.finished_at)).slice(0,3).map(r=>r.id);
    const parent=path.join(root,'releases',app.id);let folders=[];
    try{await ordinary(root,parent);folders=await fs.readdir(parent,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')project.warnings.push(error.message);continue;}
    for(const entry of folders) {
      const record=history.find(r=>r.id===entry.name),file=path.join(parent,entry.name),state=path.join(root,'release-state',entry.name);
      let eligible=false,reason='Unrecognized release; preserved',bytes=0;
      try{
        await ordinary(root,file);bytes=await sizeTree(file);
        if(!ID.test(entry.name)||!record)reason='No verified Manager deployment history; preserved';
        else if(refs.some(ref=>[file,state].some(base=>{const rel=path.relative(base,ref);return !rel||(!rel.startsWith('..')&&!path.isAbsolute(rel));})))reason='Current application, worker, scheduled job or recovery references these files';
        else if(await fs.stat(path.join(file,'.manager-pin')).then(()=>true).catch(()=>false))reason='Pinned release';
        else if(newest.includes(record.id))reason='One of the latest three successful deployments';
        else if(!['success','failed','cancelled'].includes(record.status)||!Number.isFinite(Date.parse(record.finished_at)))reason='Deployment is unfinished';
        else if(Date.now()-Date.parse(record.finished_at)<(record.status==='success'?7:3)*86400000)reason='Within the deployment retention period';
        else {eligible=true;reason='Expired deployment workspace';}
        if(await fs.stat(state).then(()=>true).catch(()=>false)){await ordinary(root,state);bytes+=await sizeTree(state);}
      }catch(error){eligible=false;reason=error.message;}
      const detail={name:entry.name,path:file,statePath:state,bytes,eligible,reason};reportBytes+=Buffer.byteLength(JSON.stringify(detail));
      if(reportBytes>180000){report.warnings.push('The bounded scan reached its report limit. Unlisted folders are preserved; clean the reviewed entries and scan again.');return report;}
      project.entries.push(detail);
      report[eligible?'eligibleBytes':'retainedBytes']+=bytes;
    }
  }
  return report;
}
async function disk(root,input,tools,h) {
  const file=path.join(root,'cleanup-preview.json');
  const report=await diskPlan(root,input,tools,h);
  if(input.mode==='scan') {
    const token=digest(report.projects);await h.atomicJson(file,{token,at:Date.now(),paths:report.projects.flatMap(p=>p.entries.filter(e=>e.eligible).map(e=>e.path))});
    return {ok:true,report,mode:input.mode,automatic:!!input.automatic,reviewToken:token};
  }
  if(input.mode!=='clean')throw Error('Unknown cleanup mode');
  const review=await h.readJson(file);
  if(!input.automatic&&(!review||review.token!==input.reviewToken||Date.now()-review.at>1800000))throw Error('Scan storage again before cleaning; the preview expired');
  // Each directory is re-planned and ancestry checked immediately before rm.
  for(const entry of report.projects.flatMap(p=>p.entries).filter(e=>e.eligible)) {
    if(!input.automatic&&!review.paths.includes(entry.path))continue;
    const fresh=await diskPlan(root,input,tools,h);const still=fresh.projects.flatMap(p=>p.entries).find(e=>e.path===entry.path);
    if(!still?.eligible){report.warnings.push('Protection changed for '+entry.name);continue;}
    await ordinary(root,entry.path);await sizeTree(entry.path);
    await fs.rm(entry.path,{recursive:true});
    if(await fs.stat(entry.statePath).then(()=>true).catch(()=>false)){await ordinary(root,entry.statePath);await sizeTree(entry.statePath);await fs.rm(entry.statePath,{recursive:true});}
    report.removed.push({path:entry.path,bytes:entry.bytes,partial:false});report.removedBytes+=entry.bytes;
  }
  await fs.unlink(file).catch(()=>{});return {ok:true,report,mode:input.mode,automatic:!!input.automatic};
}
async function execute(root,job,tools,h) {
  const input=job.payload.resource;
  if(!input||typeof input.action!=='string')throw Error('Missing resource operation');
  await recover(root,tools,h);
  if(input.action==='disk')return disk(root,input,tools,h);
  if(['memory','start-method'].includes(input.action))return appChange(root,input,tools,h);
  if(['sleep','wake'].includes(input.action))return sleepChange(root,input,tools,h);
  if(input.action==='recovery')return recovery(root,input,tools,h);
  if(input.action==='database-review')return databaseReview(root,input,h);
  if(input.action==='database-inspect')return inspectDatabases(root,input,h);
  if(input.action==='database-tune')return tuneDatabase(root,input,h);
  if(input.action.startsWith('worker-')||input.action==='cron-run')return automation(root,input,tools,h);
  throw Error('Unknown resource operation');
}
async function databaseSql(root,d,sql,h) {
  if(!['postgresql','mysql','mariadb'].includes(d.provider)||!['127.0.0.1','localhost','::1'].includes(d.host)||!Number.isInteger(d.port)||d.port<1||d.port>65535)throw Error('Only loopback database inspection is allowed');
  const paths=await h.readJson(path.join(root,'tool-paths.json'),{});
  if(d.provider==='postgresql')return h.run(paths.psql||'psql',['-X','--no-password','--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--host',d.host,'--port',String(d.port),'--username',d.username,'--dbname',d.database||'postgres'],{env:{...h.baseEnv(),PGPASSWORD:d.password,PGSSLMODE:d.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'8',PGOPTIONS:'-c statement_timeout=10000'},input:sql+';\n',timeout:15000,secrets:[d.password],stdoutOnly:true});
  const file=await h.contained(root,`inspect-db-${require('node:crypto').randomBytes(12).toString('hex')}.cnf`),quote=v=>'"'+String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/[\r\n\0]/g,'')+'"';
  try{await fs.writeFile(file,`[client]\nhost=${quote(d.host)}\nport=${d.port}\nuser=${quote(d.username)}\npassword=${quote(d.password)}\nprotocol=tcp\nconnect-timeout=8\n${d.provider==='mysql'?'ssl-mode='+(d.tls?'VERIFY_IDENTITY':'DISABLED'):d.tls?'ssl\nssl-verify-server-cert':'skip-ssl'}\n`,{mode:0o600,flag:'wx'});return await h.run(paths[d.provider]||d.provider,[`--defaults-extra-file=${file}`,'--batch','--skip-column-names','--raw'],{input:sql+';\n',timeout:15000,secrets:[d.password],stdoutOnly:true});}finally{await fs.unlink(file).catch(()=>{});}
}
async function inspectDatabase(root,d,h) {
  const report={connectionId:d.id,name:d.name||d.provider,engine:d.provider,port:d.port,version:null,memoryMb:null,service:null,dataMb:null,databases:null,connections:null,apps:d.apps||[],recommendations:[],notes:[],error:null,platform:process.platform};
  try{
    if(d.provider==='postgresql') {
      const result=JSON.parse(await databaseSql(root,d,"SELECT json_build_object('version',current_setting('server_version'),'dataMb',(select round(sum(pg_database_size(datname))/1048576.0) from pg_database where not datistemplate),'databases',(select count(*) from pg_database where not datistemplate),'groups',(select coalesce(json_agg(g),'[]'::json) from (select coalesce(usename,'-') as login,coalesce(datname,'-') as database,coalesce(state,'background') as state,count(*)::int as count from pg_stat_activity where backend_type='client backend' group by 1,2,3) g))",h));Object.assign(report,result);
      const groups=result.groups||[];report.connections={groups,total:groups.reduce((s,g)=>s+g.count,0),idle:groups.filter(g=>g.state==='idle').reduce((s,g)=>s+g.count,0)};delete report.groups;
    }else{
      const pairs=out=>Object.fromEntries(out.split(/\r?\n/).filter(Boolean).map(line=>{const i=line.indexOf('\t');return[line.slice(0,i).toLowerCase(),line.slice(i+1)];}));
      const variables=pairs(await databaseSql(root,d,"show global variables where Variable_name in ('version','version_comment','performance_schema','innodb_log_buffer_size','innodb_buffer_pool_size')",h));
      const status=pairs(await databaseSql(root,d,"show global status where Variable_name in ('Mysqlx_connections_accepted','Threads_connected')",h));
      const groups=(await databaseSql(root,d,"select JSON_OBJECT('login',user,'database',coalesce(db,'-'),'state',if(command='Sleep','idle','active'),'count',count(*)) from information_schema.processlist where user <> 'event_scheduler' group by user,db,command",h)).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const size=JSON.parse(await databaseSql(root,d,"select JSON_OBJECT('dataMb',round(coalesce(sum(data_length+index_length),0)/1048576),'databases',count(distinct table_schema)) from information_schema.tables where table_schema not in ('mysql','sys','performance_schema','information_schema')",h));
      let performanceSchemaMb=null;try{const output=await databaseSql(root,d,"select round(sum(CURRENT_NUMBER_OF_BYTES_USED)/1048576) from performance_schema.memory_summary_global_by_event_name where event_name like 'memory/performance_schema/%'",h);if(/^\d+$/.test(output.trim()))performanceSchemaMb=Number(output.trim());}catch{}
      const x=await databaseSql(root,d,"select plugin_status from information_schema.plugins where plugin_name='mysqlx'",h);
      report.facts={engine:/mariadb/i.test(variables.version+' '+variables.version_comment)?'mariadb':'mysql',variables,status,performanceSchemaMb,xPluginActive:x.trim()==='ACTIVE'};Object.assign(report,size,{version:variables.version,connections:{groups,total:groups.reduce((s,g)=>s+g.count,0),idle:groups.filter(g=>g.state==='idle').reduce((s,g)=>s+g.count,0)}});
    }
    if(process.platform==='win32') {
      const script=`$ErrorActionPreference='Stop';$ports=@(Get-NetTCPConnection -State Listen -LocalPort ${d.port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique);$procs=@(Get-CimInstance Win32_Process);$owned=@($ports);for($i=0;$i -lt 12;$i++){foreach($p in $procs){if($owned -contains [int]$p.ProcessId -and $owned -notcontains [int]$p.ParentProcessId){$owned+= [int]$p.ParentProcessId}}};$svc=@(Get-CimInstance Win32_Service | Where-Object {$_.ProcessId -ne 0 -and $owned -contains [int]$_.ProcessId -and $_.PathName -match '(?i)(mysqld|mariadbd|pg_ctl|postgres)'});if($svc.Count -eq 1){$all=@([int]$svc[0].ProcessId);for($i=0;$i -lt 12;$i++){foreach($p in $procs){if($all -contains [int]$p.ParentProcessId -and $all -notcontains [int]$p.ProcessId){$all += [int]$p.ProcessId}}};@{service=$svc[0].Name;memoryMb=[math]::Round((($procs|Where-Object {$all -contains [int]$_.ProcessId}|Measure-Object PrivatePageCount -Sum).Sum)/1MB)}|ConvertTo-Json -Compress}`;
      const output=await h.run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,stdoutOnly:true});if(output.trim())Object.assign(report,JSON.parse(output));
    }
    if(!report.service)report.notes.push('The service identity could not be verified. Memory tuning requires a verified Windows MySQL or MariaDB service.');
  }catch{report.error='Database inspection was incomplete. Verify the saved account and its monitoring permissions; existing data was not changed.';}
  return report;
}
async function inspectDatabases(root,input,h) {
  const servers=[];for(const d of (input.connections||[]).slice(0,20))servers.push(await inspectDatabase(root,d,h));
  for(const [engine,tool] of [['postgresql','psql'],['mysql','mysql'],['mariadb','mariadb']])if(input.tools?.[tool]&&!servers.some(s=>s.engine===engine))servers.push({connectionId:engine,name:engine,engine,port:engine==='postgresql'?5432:3306,version:input.tools[tool],memoryMb:null,service:null,dataMb:null,databases:null,connections:null,apps:[],recommendations:[],notes:['A database client is available. Attach an existing database with its account in an application’s Storage setup to inspect it; a client alone does not establish that a server is installed.'],error:null});
  return {ok:true,servers,canTune:false};
}
async function tuneDatabase(root,input,h) {
  if(process.platform!=='win32'||!['mysql','mariadb'].includes(input.connection?.provider)||!ID.test(input.connection?.id)||typeof input.settings!=='string'||!input.settings.split(';').every(v=>/^(performance_schema=OFF|mysqlx=OFF|innodb_log_buffer_size=16M)$/.test(v)))throw Error('Invalid database tuning request');
  const before=await inspectDatabase(root,input.connection,h);
  if(before.error||before.service!==input.service||digest(before.facts)!==digest(input.facts))throw Error('Database settings changed; check again before tuning');
  const dir=await h.contained(root,'database-tuning',require('node:crypto').randomUUID());await fs.mkdir(dir,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(dir,'database-service.ps1'),input.serviceScript,{mode:0o600});await fs.writeFile(path.join(dir,'tune-database-memory.ps1'),input.script,{mode:0o600});
  const output=await h.run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'tune-database-memory.ps1'),'-Engine',input.connection.provider,'-ServiceName',input.service,'-Settings',input.settings],{timeout:300000});
  const after=await inspectDatabase(root,input.connection,h);if(after.error)throw Error('Database restarted but connection verification failed. Inspect its service and error log.');
  return {ok:true,result:{ok:true,settings:input.settings,before:before.memoryMb,after:after.memoryMb,log:output.split(/\r?\n/),apps:before.apps}};
}
async function recovery(root,input,tools,h) {
  const saved=await h.readJson(path.join(root,'apps.json'),{}),app=saved[input.id],before=await h.processList(tools.pm),name=`manager-remote-${input.id}`,p=before.find(p=>p.name===name);
  if(!ID.test(input.id)||!app||app.commit!==input.commit||p?.pid!==input.pid||p?.pm2_env?.restart_time!==input.restarts||!['online','errored'].includes(p?.pm2_env?.status)||app.app.port!==input.port||app.app.health_path!==input.health_path)throw Error('Application state changed after review; prepare a new review');
  let alreadyHealthy=false,databaseFailure=false;
  try{const response=await fetch(`http://127.0.0.1:${app.app.port}${app.app.health_path||'/'}`,{redirect:'manual',signal:AbortSignal.timeout(5000)});alreadyHealthy=response.ok;const d=!response.ok?await readDiagnostics(response):null;databaseFailure=d?.issueCode?.startsWith('database')===true;await response.body?.cancel().catch(()=>{});}catch{}
  if(alreadyHealthy)throw Error('The app is healthy now. No recovery restart was performed.');
  if(databaseFailure)throw Error('Readiness identifies a database dependency problem. No recovery restart was performed.');
  await tools.pm(['restart',name]);await tools.pm(['save','--force']);
  try{
    await h.healthy(app.app);await new Promise(r=>setTimeout(r,2000));await h.healthy(app.app,10000);
    const after=await h.processList(tools.pm);
    if(before.filter(p=>p.name!==name).some(p=>{const n=after.find(n=>n.name===p.name);return !n||n.pid!==p.pid||n.pm2_env?.restart_time!==p.pm2_env?.restart_time;}))throw Error('Another private process changed during verification; inspect its state');
    invalidate(root);return {ok:true,result:{healthy:true,message:'This app passed two readiness checks after its restart. Other private processes were unchanged.'}};
  }catch(error){return {ok:true,result:{healthy:false,message:'Recovery verification failed: '+error.message+'. Further automatic attempts are blocked until reviewed.'}};}
}
async function databaseReview(root,input,h) {
  const saved=await h.readJson(path.join(root,'apps.json'),{}),item=saved[input.id];if(!ID.test(input.id)||!item)throw Error('Managed application not found');
  const launch=await h.readJson(path.join(path.dirname(item.ecosystem),'launch.json'));
  const keys=Object.keys(launch?.env||{}).filter(k=>/^(DATABASE_|DB_|PGHOST$|PGPORT$|PGUSER$|PGPASSWORD$|PGDATABASE$|MONGODB_URI$|REDIS_URL$)/.test(k));
  const present=keys.filter(k=>String(launch.env[k]).trim()),empty=keys.filter(k=>!String(launch.env[k]).trim());
  return {ok:true,database:{projectName:item.app.name,files:[{file:'Active deployment runtime environment',present,empty}],missing:present.includes('DATABASE_URL')||present.includes('DB_URL')?[]:['DB_HOST','DB_DATABASE','DB_USERNAME'].filter(k=>!present.includes(k)),services:[],warnings:[],nextSteps:['Review the application’s saved database connection in Storage.','Test the saved database connection from this server, then check readiness.'],limitations:'Only variable names and whether they are populated are returned. No secret values or configuration changes.',href:input.href||'#server-access'}};
}
function gatewayKey(root,id){return root+'|'+id;}
async function wake(root,id,tools,h,manual=false) {
  const state=gateways.get(gatewayKey(root,id));if(!state)throw Error('Staging wake gateway is not running');
  state.lastActiveAt=Date.now();if(state.waking)return state.waking;
  state.waking=(async()=>{
    if(!manual&&(busyRoots.has(root)||(await h.readJson(path.join(root,'current-job.json')))?.status==='running'))throw Error('A server operation is active; retry shortly');
    const item=(await h.readJson(path.join(root,'apps.json'),{}))[id];if(!item)throw Error('Managed staging app not found');
    const list=await h.processList(tools.pm),name=`manager-remote-${id}`,p=list.find(p=>p.name===name);
    if(p?.pm2_env?.status!=='online'){if(p)await tools.pm(['start',name]);else await tools.pm(['start',await h.contained(root,path.relative(root,item.ecosystem))]);await h.healthy(item.app);await tools.pm(['save','--force']);}
    state.sleepingSince=null;invalidate(root);
  })().finally(()=>{state.waking=null;});return state.waking;
}
async function startGateway(root,id,settings,tools,h) {
  const key=gatewayKey(root,id);if(gateways.has(key))return gateways.get(key);
  const http=require('node:http'),net=require('node:net');
  const state={port:settings.gatewayPort,lastActiveAt:Date.parse(settings.lastActiveAt)||Date.now(),sleepingSince:settings.sleepingSince||null,active:0,waking:null,server:null,sockets:new Set()};
  const server=http.createServer(async(req,res)=>{
    state.lastActiveAt=Date.now();state.active++;let ended=false;const done=()=>{if(!ended){ended=true;state.active--;state.lastActiveAt=Date.now();}};res.on('close',done);
    try{
      if(state.sleepingSince||state.waking){void wake(root,id,tools,h).catch(()=>{});res.writeHead(503,{'Content-Type':'text/html; charset=utf-8','Retry-After':'3','Cache-Control':'no-store'});res.end('<!doctype html><meta http-equiv="refresh" content="3"><title>Starting application</title><p>This staging application is starting. Retrying shortly…</p>');return;}
      const item=(await h.readJson(path.join(root,'apps.json'),{}))[id];if(!item)throw Error('Application unavailable');
      const upstream=http.request({hostname:'127.0.0.1',port:item.app.port,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Application unavailable');});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    }catch{res.writeHead(503);res.end('Application unavailable');}
  });
  server.on('upgrade',async(req,socket,head)=>{
    state.lastActiveAt=Date.now();state.active++;socket.on('close',()=>{state.active--;state.lastActiveAt=Date.now();});
    if(state.sleepingSince||state.waking){void wake(root,id,tools,h).catch(()=>{});socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 3\r\nConnection: close\r\n\r\n');return;}
    try{const item=(await h.readJson(path.join(root,'apps.json'),{}))[id];if(!item)throw Error();const upstream=net.connect(item.app.port,'127.0.0.1',()=>{upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`+req.rawHeaders.reduce((s,v,i,a)=>i%2?s:s+v+': '+a[i+1]+'\r\n','')+'\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());}catch{socket.destroy();}
  });
  server.on('connection',socket=>{state.sockets.add(socket);socket.on('close',()=>state.sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.gatewayPort||0,'127.0.0.1',resolve);});server.on('error',()=>{});state.port=server.address().port;state.server=server;gateways.set(key,state);return state;
}
async function start(root,tools,h) {
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}});
  for(const [id,setting] of Object.entries(cfg.apps||{}))if(ID.test(id)&&setting.gatewayPort)await startGateway(root,id,setting,tools,h);
}
async function proxyApps(root,apps,h) {
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}});
  return apps.map(a=>{const s=cfg.apps?.[a.id];return s?.sleepAfterMinutes&&s.gatewayPort?{...a,port:s.gatewayPort}:a;});
}
async function sleepChange(root,input,tools,h) {
  const saved=await h.readJson(path.join(root,'apps.json'),{}),item=saved[input.id];
  if(!ID.test(input.id)||!item||input.environment!=='staging')throw Error('Only managed staging apps may sleep');
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}});cfg.apps||={};const previous=JSON.parse(JSON.stringify(cfg)),setting=cfg.apps[input.id]||{};
  if(input.action==='wake'){await startGateway(root,input.id,setting,tools,h);await wake(root,input.id,tools,h,true);setting.sleepingSince=null;setting.lastActiveAt=new Date().toISOString();cfg.apps[input.id]=setting;await h.atomicJson(path.join(root,'resources.json'),cfg);return{ok:true};}
  if(input.minutes!==null&&![15,30,60,120,240,480,720,1440].includes(input.minutes))throw Error('Choose a supported idle interval');
  const gateway=await startGateway(root,input.id,setting,tools,h);
  await wake(root,input.id,tools,h,true);
  cfg.apps[input.id]={...setting,sleepAfterMinutes:input.minutes,gatewayPort:gateway.port,lastActiveAt:new Date().toISOString(),sleepingSince:null,environment:'staging'};
  await h.atomicJson(path.join(root,'resources.json'),cfg);
  try{await h.proxyConfig(root,await h.managedCaddyConfig(root,Object.values(saved).map(x=>x.app)),tools);}catch(error){await h.atomicJson(path.join(root,'resources.json'),previous);throw error;}
  invalidate(root);return {ok:true,minutes:input.minutes};
}
async function idle(root,tools,h) {
  const cfg=await h.readJson(path.join(root,'resources.json'),{apps:{}}),saved=await h.readJson(path.join(root,'apps.json'),{});let changed=false;
  for(const [id,setting] of Object.entries(cfg.apps||{})) {
    if(!saved[id]||!setting.gatewayPort)continue;
    const state=await startGateway(root,id,setting,tools,h);
    if(setting.sleepAfterMinutes&&setting.environment==='staging'&&!state.sleepingSince&&!state.active&&!state.waking&&Date.now()-state.lastActiveAt>setting.sleepAfterMinutes*60000){await tools.pm(['stop',`manager-remote-${id}`]);await tools.pm(['save','--force']);state.sleepingSince=new Date().toISOString();}
    const last=new Date(state.lastActiveAt).toISOString();if(setting.sleepingSince!==state.sleepingSince||Math.abs(Date.parse(setting.lastActiveAt||'')-state.lastActiveAt)>60000){setting.sleepingSince=state.sleepingSince;setting.lastActiveAt=last;changed=true;}
  }
  if(changed){await h.atomicJson(path.join(root,'resources.json'),cfg);invalidate(root);}
}
async function setBusy(root,value){if(value){busyRoots.add(root);await Promise.all([...gateways.entries()].filter(([k])=>k.startsWith(root+'|')).map(([,s])=>s.waking).filter(Boolean).map(p=>p.catch(()=>{})));}else busyRoots.delete(root);}
async function stop(root){for(const [key,s] of gateways)if(key.startsWith(root+'|')){for(const socket of s.sockets)socket.destroy();await new Promise(resolve=>s.server.close(resolve));gateways.delete(key);}busyRoots.delete(root);cache.delete(root);}
async function automationContext(root,config,h) {
  if(!config||typeof config.command!=='string'||!config.command.trim()||config.command.length>4000||/[\0\r\n]/.test(config.command)||typeof config.workingDirectory!=='string'||!path.isAbsolute(config.workingDirectory))throw Error('Invalid automation configuration');
  let directory=config.workingDirectory;
  let env=h.baseEnv();
  const saved=await h.readJson(path.join(root,'apps.json'),{});
  if(config.projectId&&!saved[config.projectId])throw Error('Deploy the selected application before running its scheduled job');
  for(const [id,app] of Object.entries(saved)) {
    const launch=await h.readJson(path.join(path.dirname(app.ecosystem),'launch.json'));
    if(launch&&(config.projectId===id||path.resolve(launch.cwd).toLowerCase()===path.resolve(directory).toLowerCase())){
      env={...env,...launch.env};
      if(config.projectId===id&&typeof config.projectRoot==='string'&&path.isAbsolute(config.projectRoot)){const relative=path.relative(config.projectRoot,directory);if(!relative||!relative.startsWith('..')&&!path.isAbsolute(relative))directory=path.join(launch.cwd,relative);}
      break;
    }
  }
  const cwd=await fs.realpath(directory);
  if(!(await fs.stat(cwd)).isDirectory())throw Error('Working directory must exist on this server');
  return {cwd,env};
}
async function automation(root,input,tools,h) {
  if(!ID.test(input.id))throw Error('Invalid job or worker identifier');
  const file=path.join(root,'workers.json'),saved=await h.readJson(file,{}),name=`manager-worker-${input.id}`,list=await h.processList(tools.pm);
  if(input.action==='cron-run'){
    const {cwd,env}=await automationContext(root,input.config,h),seconds=input.config.timeoutSeconds;
    if(!Number.isInteger(seconds)||seconds<10||seconds>3600)throw Error('Invalid scheduled job timeout');
    const output=await h.run(input.config.command,[],{shell:true,cwd,env,timeout:seconds*1000,secrets:Object.values(env)});
    return {ok:true,output,exitCode:0};
  }
  if(!['worker-save','worker-delete'].includes(input.action)&&!saved[input.id])throw Error('This private worker is not registered on the selected agent');
  if(input.action==='worker-logs') {
    const p=list.find(p=>p.name===name),files=[p?.pm2_env?.pm_out_log_path,p?.pm2_env?.pm_err_log_path].filter(Boolean);
    const {env}=await automationContext(root,saved[input.id],h);let output='';
    for(const log of files){const absolute=await h.contained(root,path.relative(root,log));let handle;try{handle=await fs.open(absolute,'r');const stat=await handle.stat(),buffer=Buffer.alloc(Math.min(stat.size,32000));await handle.read(buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));output+=h.redact(buffer.toString(),Object.values(env));}catch(error){if(error.code!=='ENOENT')throw error;}finally{await handle?.close();}}
    return {ok:true,output};
  }
  if(input.action==='worker-delete') {if(list.some(p=>p.name===name))await tools.pm(['delete',name]);delete saved[input.id];await tools.pm(['save','--force']);await h.atomicJson(file,saved);invalidate(root);return {ok:true};}
  if(['worker-start','worker-stop','worker-restart'].includes(input.action)){
    const action=input.action.slice(7),ecosystem=await h.contained(root,'workers',input.id,'ecosystem.config.js');
    if(action==='restart'||action==='start'&&!list.some(p=>p.name===name&&p.pm2_env?.status==='online'))return automation(root,{action:'worker-save',id:input.id,config:{...saved[input.id],enabled:true}},tools,h);
    if(action==='start'&&!list.some(p=>p.name===name))await tools.pm(['start',ecosystem]);else await tools.pm([action,name]);
    await tools.pm(['save','--force']);invalidate(root);return {ok:true};
  }
  if(input.action!=='worker-save')throw Error('Unknown worker operation');
  const config=input.config,{cwd,env}=await automationContext(root,config,h);
  const dir=await h.contained(root,'workers',input.id);await fs.mkdir(dir,{recursive:true,mode:0o700});
  const runner=path.join(dir,'runner.cjs'),ecosystem=path.join(dir,'ecosystem.config.js'),launchFile=path.join(dir,'launch.json');
  const old=saved[input.id],oldDefinition=await fs.readFile(ecosystem,'utf8').catch(()=>null),oldLaunch=await h.readJson(launchFile);
  await fs.writeFile(runner,`'use strict';const {spawn,spawnSync}=require('node:child_process');const c=require('./launch.json');const p=spawn(c.command,[],{cwd:c.cwd,env:c.env,shell:true,windowsHide:true,detached:process.platform!=='win32',stdio:'inherit'});let closing=false;function stop(){if(closing)return;closing=true;if(p.pid){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else try{process.kill(-p.pid,'SIGTERM')}catch{}}setTimeout(()=>{if(process.platform!=='win32'&&p.pid)try{process.kill(-p.pid,'SIGKILL')}catch{};process.exit(0)},3000).unref()}process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('message',m=>{if(m==='shutdown')stop()});p.on('error',e=>{console.error(e.message);process.exit(1)});p.on('exit',c=>{if(!closing)process.exit(c??1)});`,{mode:0o600});
  try {
    await h.atomicJson(launchFile,{command:config.command,cwd,env});
    await fs.writeFile(ecosystem,`module.exports=${JSON.stringify({apps:[{name,script:runner,cwd,interpreter:process.execPath,kill_timeout:10000,shutdown_with_message:true,min_uptime:'10s',max_restarts:10}]})};`,{mode:0o600});
    if(list.some(p=>p.name===name))await tools.pm(['delete',name]);
    if(config.enabled){await tools.pm(['start',ecosystem]);await new Promise(r=>setTimeout(r,1200));if(!(await h.processList(tools.pm)).some(p=>p.name===name&&p.pm2_env?.status==='online'))throw Error('Worker did not remain online');}
    saved[input.id]=config;await h.atomicJson(file,saved);await tools.pm(['save','--force']);invalidate(root);return {ok:true};
  }catch(error){await tools.pm(['delete',name]).catch(()=>{});if(old&&oldDefinition&&oldLaunch){await fs.writeFile(ecosystem,oldDefinition,{mode:0o600});await h.atomicJson(launchFile,oldLaunch);if(list.some(p=>p.name===name&&p.pm2_env?.status==='online'))await tools.pm(['start',ecosystem]);}await tools.pm(['save','--force']);throw error;}
}
module.exports={CAPABILITY,sanitize,telemetry,invalidate,execute,recover,applyLaunchSettings,diskPlan,disk,ordinary,sizeTree,directPlan,heapOptions,start,proxyApps,idle,setBusy,stop,readDiagnostics,sanitizeDiagnostics};
