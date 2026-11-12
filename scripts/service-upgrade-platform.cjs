'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createReadStream}=require('node:fs'),{createHash}=require('node:crypto');
const {randomUUID}=require('node:crypto');
const {run,regular,inside,files}=require('./service-upgrade.cjs');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const ps=(source,timeout=120000)=>run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath;"+source,'utf16le').toString('base64')],{timeout});
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function copyTree(source,destination){
  await regular(source,true);await files(source);if(await fs.lstat(destination).catch(()=>null))throw Error('Backup destination already exists');
  if(process.platform==='win32')await ps(`& robocopy.exe ${quote(source)} ${quote(destination)} /E /COPYALL /DCOPY:DAT /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null;if($LASTEXITCODE -gt 7){throw 'Database copy failed'};exit 0`);
  else{await fs.mkdir(destination,{mode:0o700});await run('cp',['-a','--',source+path.sep+'.',destination]);}
}
async function asAgent(root,script,args){
  const paths=JSON.parse(await fs.readFile(path.join(root,'tool-paths.json'),'utf8'));if(!path.isAbsolute(paths.node))throw Error('The agent Node executable is unavailable');
  if(process.platform!=='win32')return run('runuser',['-u','manager-agent','--',paths.node,script,...args],{cwd:root,timeout:180000});
  const name='ManagerUpgradeCheck-'+randomUUID(),folder=path.join(root,name),file=path.join(folder,'check.ps1'),result=path.join(folder,'result.txt');await fs.mkdir(folder);
  await fs.writeFile(file,`Set-Location -LiteralPath ${quote(root)}; & ${quote(paths.node)} ${quote(script)} ${args.map(quote).join(' ')} *> ${quote(result+'.log')}; [IO.File]::WriteAllText(${quote(result)},[string]$LASTEXITCODE)`);
  const task=`$a=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument ${quote('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+file+'"')};Register-ScheduledTask -TaskName ${quote(name)} -Action $a -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited)|Out-Null;try{Start-ScheduledTask -TaskName ${quote(name)};for($i=0;$i -lt 150;$i++){if(Test-Path -LiteralPath ${quote(result)}){break};Start-Sleep -Seconds 1};if(-not(Test-Path -LiteralPath ${quote(result)})){throw 'Agent maintenance check timed out'}}finally{Stop-ScheduledTask -TaskName ${quote(name)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false}`;
  await ps(task,180000);if((await fs.readFile(result,'utf8')).trim()!=='0')throw Error('Agent maintenance failed: '+(await fs.readFile(result+'.log','utf8')).replaceAll('\0','').slice(-2000));
}
async function inspectService(name){
  if(!/^[A-Za-z0-9_.@$-]{1,200}$/.test(name)||/^manageragent|^managerupdater/i.test(name))throw Error('Invalid maintenance service identity');
  if(process.platform==='win32'){
    const value=JSON.parse(await ps(`$s=Get-CimInstance Win32_Service -Filter ${quote("Name='"+name+"'")};if(-not $s){throw 'Service not found'};@{name=$s.Name;command=$s.PathName;status=$s.State;pid=$s.ProcessId;account=$s.StartName;startMode=$s.StartMode}|ConvertTo-Json -Compress`));
    value.executable=value.command.match(/^\s*"([^"]+)"/)?.[1]||value.command.match(/^\s*(.+?\.exe)(?:\s|$)/i)?.[1];return value;
  }
  const output=await run('systemctl',['show',name,'--property=Id,ExecStart,ActiveState,MainPID,User,UnitFileState']),fields=Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)]}));
  const executable=fields.ExecStart?.match(/path=(.*?)\s*;/)?.[1];if(!executable)throw Error('Cannot identify the exact systemd executable');return {name:fields.Id,command:systemdCommand(fields.ExecStart),status:fields.ActiveState==='active'?'Running':fields.ActiveState,pid:Number(fields.MainPID),account:fields.User,startMode:fields.UnitFileState,executable};
}
// ExecStart includes run timestamps, PID and exit status, which change on stop.
// Preserve the executable, arguments and ignore_errors setting for identity checks.
function systemdCommand(value){return value.split(/\s*;\s*start_time=/)[0].trim();}
async function transition(name,action){
  if(process.platform==='win32')await ps(`${action==='stop'?'Stop':'Start'}-Service -Name ${quote(name)} -ErrorAction Stop;$s=Get-Service -Name ${quote(name)};$s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::${action==='stop'?'Stopped':'Running'},[TimeSpan]::FromSeconds(90))`);
  else await run('systemctl',[action,name]);
}
async function databaseInfo(plan,stage){
  if(!plan.databaseCredential?.username||!plan.databaseCredential?.password)throw Error('Provide an existing database administrator credential for authenticated upgrade verification');
  const {loadPostgresRuntime}=require('./agent-runtime-loader.cjs'),{contained}=require('./initialize-remote-database.cjs'),name=plan.service==='postgresql'?'pg':['mysql','mariadb'].includes(plan.service)?'mysql2/promise':plan.service==='mongodb'?'mongodb':'redis',driver=await loadPostgresRuntime(stage,plan.driverArchive,{contained},name),common={host:'127.0.0.1',port:plan.port,user:plan.databaseCredential.username,password:plan.databaseCredential.password};
  if(plan.service==='postgresql'){
    const client=new driver.Client({...common,database:'postgres',connectionTimeoutMillis:5000,query_timeout:10000});try{await client.connect();const r=(await client.query("select current_setting('server_version') as version,current_setting('data_directory') as data,current_setting('config_file') as config,pg_is_in_recovery() as replica")).rows[0];if(r.replica)throw Error('Use a replication-aware maintenance procedure for this database');return r;}finally{await client.end().catch(()=>{})}
  }
  if(['mysql','mariadb'].includes(plan.service)){
    const client=await driver.createConnection({...common,connectTimeout:5000});try{const [rows]=await client.query('SELECT @@version AS version,@@datadir AS data,@@read_only AS replica');if(Number(rows[0].replica))throw Error('Use a replication-aware maintenance procedure for this database');const [replication]=await client.query(plan.service==='mysql'?'SHOW REPLICA STATUS':'SHOW SLAVE STATUS');if(replication.length)throw Error('Use a replication-aware maintenance procedure for this database');return rows[0];}finally{await client.end()}
  }
  if(plan.service==='mongodb'){
    const client=new driver.MongoClient(`mongodb://127.0.0.1:${plan.port}/?authSource=admin`,{auth:{username:common.user,password:common.password},serverSelectionTimeoutMS:5000});try{await client.connect();const admin=client.db('admin'),hello=await admin.command({hello:1});if(hello.setName||hello.msg==='isdbgrid')throw Error('Use a replication-aware maintenance procedure for this database');const build=await admin.command({buildInfo:1}),options=await admin.command({getCmdLineOpts:1});return {version:build.version,data:options.parsed.storage.dbPath};}finally{await client.close()}
  }
  const client=driver.createClient({url:`redis://127.0.0.1:${plan.port}`,username:common.user,password:common.password,socket:{connectTimeout:5000,reconnectStrategy:false}});client.on('error',()=>{});try{await client.connect();const replication=await client.info('replication');if(!/role:master/.test(replication)||!/connected_slaves:0/.test(replication))throw Error('Use a replication-aware maintenance procedure for this database');if(/cluster_enabled:1/.test(await client.info('cluster')))throw Error('Use a cluster-aware maintenance procedure for Redis');const info=await client.info('server'),config=await client.configGet('dir');return {version:info.match(/redis_version:([^\r\n]+)/)?.[1],data:config.dir};}finally{if(client.isOpen)client.destroy()}
}
async function adapterFor(plan,installRoot,stage){
  if(!plan.serviceName)return {};
  const initial=await inspectService(plan.serviceName);if(!initial.executable||!inside(installRoot,initial.executable))throw Error('The selected service does not run from this installation');
  if(initial.status!=='Running')throw Error('Start and verify the existing service before reviewing its update');
  if(!plan.configPath)throw Error('Provide the existing service configuration path');await regular(plan.configPath);const config=await fs.readFile(plan.configPath),database=require('./service-upgrade-policy.cjs').services[plan.service].kind==='database';
  if(database){await regular(plan.databaseDataPath,true);if(path.resolve(plan.databaseDataPath)===path.resolve(installRoot)||inside(plan.databaseDataPath,installRoot))throw Error('The binary installation must be separate from its database data');const info=await databaseInfo(plan,stage);if(path.resolve(info.data).toLowerCase()!==path.resolve(plan.databaseDataPath).toLowerCase())throw Error('The data directory does not match the authenticated database');if(require('./service-upgrade-policy.cjs').version(info.version)!==plan.currentVersion)throw Error('The database engine version does not match the reviewed installation');await files(plan.databaseDataPath);}
  const checkIdentity=async()=>{const actual=await inspectService(plan.serviceName);for(const key of ['command','account','startMode'])if(actual[key]!==initial[key])throw Error('Service registration changed during maintenance');if(!(await fs.readFile(plan.configPath)).equals(config))throw Error('Service configuration changed during maintenance');};
  return {database,before:checkIdentity,stop:async()=>{await checkIdentity();await transition(plan.serviceName,'stop')},start:async()=>{await checkIdentity();await transition(plan.serviceName,'start')},backup:async target=>{
    await fs.writeFile(path.join(target,'service-before.json'),JSON.stringify(initial),{flag:'wx',mode:0o600});await fs.writeFile(path.join(target,'configuration-before'),config,{flag:'wx',mode:0o600});
    if(database){const list=await files(plan.databaseDataPath);let size=0;for(const file of list)size+=(await fs.stat(path.join(plan.databaseDataPath,file))).size;const space=await fs.statfs(target);if(space.bavail*space.bsize<size*1.15+128*1024*1024)throw Error('Insufficient space for a verified cold database backup');const backup=path.join(target,'database-backup');await copyTree(plan.databaseDataPath,backup);const manifest={};for(const file of list){manifest[file]=await digest(path.join(plan.databaseDataPath,file));if(manifest[file]!==await digest(path.join(backup,file)))throw Error('Cold backup verification failed')}await fs.writeFile(path.join(target,'database-backup.json'),JSON.stringify({data:plan.databaseDataPath,files:manifest,verified:true}),{flag:'wx',mode:0o600});}
  },verify:async()=>{await checkIdentity();const actual=await inspectService(plan.serviceName);if(actual.status!=='Running'||!actual.pid)throw Error('Updated service is not running');if(database){let ready=false;for(let attempt=0;attempt<40;attempt++){try{const info=await databaseInfo(plan,stage);if(require('./service-upgrade-policy.cjs').version(info.version)!==plan.version)throw Error('The running database did not report the selected version');ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,500))}}if(!ready)throw Error('Updated database failed authenticated readiness');}return actual;}};
}
module.exports={inspectService,transition,databaseInfo,adapterFor,copyTree,digest,asAgent,systemdCommand};
