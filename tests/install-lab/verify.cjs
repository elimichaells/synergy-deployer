const fs=require('node:fs'),path=require('node:path'),https=require('node:https'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const root='C:/ManagerAcceptanceLab',read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
async function verify(mode){
  const config=read(root+'/private/install.json'),identity=read(root+'/private/identity.json');
  assert.equal(process.env.COMPUTERNAME,identity.computer);assert.equal(identity.root,root.replaceAll('/','\\'));assert.ok(['before','after'].includes(mode));
  const installed=read('C:/ProgramData/Manager/install-report.json'),version=read(config.ManagerRoot+'/package.json').version;
  const ps=code=>cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ProgressPreference='SilentlyContinue';"+code,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:30000});
  const boot=ps("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')").trim();
  if(mode==='after'){const first=read(root+'/results/install-result.json');assert.equal(first.status,'passed');assert.notEqual(new Date(boot).getTime(),new Date(first.bootBefore).getTime());assert.ok(new Date(boot)>new Date(first.bootBefore));}
  // Observe automatic startup only. This verifier never starts or restarts any service.
  const {verifyInstallation}=require(path.join(config.ManagerRoot,'scripts/verify-manager-installation.cjs'));
  console.log('Checking fresh Manager readiness and administrator login');
  const ready=await verifyInstallation({baseUrl:'http://127.0.0.1:4000',version,email:config.AdminEmail,password:config.AdminPassword,timeoutMs:240000});
  const ca=fs.readFileSync(installed.localCaCertificate),caHash=crypto.createHash('sha256').update(ca).digest('hex');
  function request(route,method='GET',body,cookie){return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null,req=https.request({hostname:'localhost',port:443,path:route,method,ca,rejectUnauthorized:true,headers:{Origin:'https://localhost',...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}),...(cookie?{Cookie:cookie}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}))});req.setTimeout(15000,()=>req.destroy(Error('HTTPS timeout')));req.on('error',reject);req.end(data);
  });}
  console.log('Checking Caddy HTTPS with the installed CA');
  let login,lastError;const httpsDeadline=Date.now()+60000;
  while(Date.now()<httpsDeadline){try{login=await request('/api/auth/login','POST',{email:config.AdminEmail,password:config.AdminPassword});break}catch(error){lastError=error;await new Promise(r=>setTimeout(r,1000));}}
  if(!login)throw Error('HTTPS did not become ready: '+(lastError?.errors?.map(e=>e.code+' '+e.address+':'+e.port).join(', ')||lastError?.message||lastError?.code));
  assert.equal(login.status,200,'verified HTTPS login');
  const cookie=login.headers['set-cookie']?.find(c=>c.startsWith('manager_session='));assert.match(cookie,/;\s*Secure/i);
  const me=await request('/api/auth/me','GET',null,cookie.split(';')[0]);assert.equal(JSON.parse(me.text).user.role,'admin');
  console.log('Checking isolated databases, private listeners and boot registration');
  const {Client}=require(path.join(config.ManagerRoot,'node_modules/pg'));
  const db=new Client({host:'127.0.0.1',port:5432,database:config.DbName,user:config.DbAppUser,password:config.DbAppPassword});await db.connect();
  let snapshot;try{
    const admin=(await db.query('select email,role,status,password_hash from users where email=$1',[config.AdminEmail])).rows[0];assert.equal(admin.role,'admin');assert.equal(admin.status,'active');
    const connections=(await db.query('select name,port,last_status,password_ciphertext from data_connections')).rows;assert.ok(connections.some(c=>c.port===5433&&c.last_status==='healthy'));
    assert.equal((await db.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper,false);
    snapshot={adminHash:crypto.createHash('sha256').update(admin.password_hash).digest('hex'),connectionHashes:connections.map(c=>crypto.createHash('sha256').update(c.password_ciphertext||'').digest('hex'))};
  }finally{await db.end()}
  const appDb=new Client({host:'127.0.0.1',port:5433,database:'postgres',user:config.AppDbAdminUser,password:config.AppDbAdminPassword});await appDb.connect();try{assert.equal((await appDb.query('select 1 n')).rows[0].n,1)}finally{await appDb.end()}
  const services=JSON.parse(ps("@(Get-CimInstance Win32_Service | Where-Object {$_.Name -in @('ManagerPostgreSQLControl','ManagerPostgreSQLApplications')} | Select-Object Name,State,StartMode) | ConvertTo-Json -Compress"));assert.equal(services.length,2);assert.ok(services.every(s=>s.State==='Running'&&s.StartMode==='Auto'));
  const listeners=JSON.parse(ps("@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(4000,5432,5433)} | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress"));assert.ok(listeners.length>=3);assert.ok(listeners.every(l=>['127.0.0.1','::1'].includes(l.LocalAddress)));
  const task=JSON.parse(ps("$task=Get-ScheduledTask -TaskName 'Manager PM2 Startup';$info=$task|Get-ScheduledTaskInfo;[pscustomobject]@{user=$task.Principal.UserId;result=$info.LastTaskResult;lastRun=$info.LastRunTime.ToUniversalTime().ToString('o');startup=@($task.Triggers|Where-Object {$_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'}).Count} | ConvertTo-Json -Compress"));assert.ok(['SYSTEM','S-1-5-18'].includes(task.user));assert.equal(task.startup,1);
  if(mode==='after'){const old=read(root+'/private/before.json');assert.equal(caHash,old.caHash,'Caddy CA persists across SYSTEM startup');assert.deepEqual(snapshot,old.snapshot,'accounts and encrypted database credentials persist');assert.equal(task.result,0);assert.ok(new Date(task.lastRun)>=new Date(boot));}
  const result={status:'passed',version,sourceCommit:read(config.ManagerRoot+'/release-source.json').sourceCommit,computer:identity.computer,runId:identity.runId,bootAfter:boot,httpsLogin:true,localCaStable:true,privateDatabaseListeners:true,databasesHealthy:true,automaticStartup:mode==='after',...ready};
  if(mode==='before')fs.writeFileSync(root+'/private/before.json',JSON.stringify({caHash,snapshot}));
  fs.writeFileSync(root+'/results/'+(mode==='after'?'reboot-result.json':'fresh-verification.json'),JSON.stringify(result,null,2));return result;
}
module.exports={verify};
if(require.main===module)verify(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1});
