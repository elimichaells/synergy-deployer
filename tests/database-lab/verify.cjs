const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(cp.execFile),root='C:/ManagerDatabaseLab',repository=path.resolve(__dirname,'../..');
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.MANAGER_DATABASE_LAB!=='1'||process.platform!=='win32')throw Error('Database acceptance test refuses non-disposable machines');
const mysql=require('mysql2/promise'),agent=require('../../scripts/manager-agent.cjs'),resources=require('../../scripts/manager-agent-resources.cjs');
const load=require('../server-module.cjs'),policy=load('lib/database-tuning-policy.ts',{}),psQuote=s=>"'"+s.replaceAll("'","''")+"'";
const report={status:'failed',checks:[],sourceCommit:process.env.GITHUB_SHA};
const ps=async code=>(await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,timeout:180000,maxBuffer:1024*1024})).stdout;
const native=async(file,args,timeout=300000)=>exec(file,args,{windowsHide:true,timeout,maxBuffer:1024*1024});
const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function sql(instance,statement){const connection=await mysql.createConnection({host:'127.0.0.1',port:instance.port,user:'root',password:instance.password||'',connectTimeout:10000});try{return(await connection.query(statement))[0]}finally{await connection.end()}}
async function identity(instance){return JSON.parse(await ps(`$service=Get-CimInstance Win32_Service -Filter "Name='${instance.name}'";$process=Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)";@{name=$service.Name;pid=$service.ProcessId;started=$process.CreationDate.ToUniversalTime().ToString('o');state=$service.State}|ConvertTo-Json -Compress`));}
async function run(){
  const inventory=JSON.parse(await fs.readFile(root+'/private/instances.json','utf8'));assert.equal(inventory.computer,process.env.COMPUTERNAME);
  const [target,peer,maria]=inventory.instances;
  for(const instance of inventory.instances){
    const until=Date.now()+60000;while(true){try{await sql(instance,'select 1');break}catch(error){if(Date.now()>until)throw error;await new Promise(r=>setTimeout(r,1000));}}
    instance.password=crypto.randomBytes(24).toString('hex');console.log('::add-mask::'+instance.password);
    const password=instance.password;instance.password='';await sql(instance,`ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}'`);instance.password=password;
    await sql(instance,'CREATE DATABASE preservation_probe');await sql(instance,'CREATE TABLE preservation_probe.values_to_keep (id int primary key,value varchar(100))');await sql(instance,"INSERT INTO preservation_probe.values_to_keep VALUES (1,'original fixture must survive')");
  }
  await fs.writeFile(root+'/private/instances.json',JSON.stringify(inventory));
  const peerBefore=await identity(peer),peerConfig=await hash(peer.config);
  const h={readJson:agent.readJson,atomicJson:agent.atomicJson,contained:agent.contained,run:agent.run,redact:agent.redact,baseEnv:()=>({...process.env})};
  const agentRoot=root+'/private/agent';await fs.mkdir(agentRoot);
  const resource=input=>resources.execute(agentRoot,{payload:{resource:input}},null,h);
  await agent.atomicJson(path.join(agentRoot,'tool-paths.json'),{mysql:target.client,mariadb:maria.client});
  const script=await fs.readFile(path.join(repository,'scripts/tune-database-memory.ps1'),'utf8'),serviceScript=await fs.readFile(path.join(repository,'scripts/database-service.ps1'),'utf8');
  for(const instance of [target,maria]){
    const connection={id:crypto.randomUUID(),provider:instance.provider,name:instance.name,host:'127.0.0.1',port:instance.port,username:'root',password:instance.password,database:'mysql',apps:['Preservation probe']};
    const before=(await resource({action:'database-inspect',connections:[connection]})).servers[0];
    assert.equal(before.error,null,instance.name+' real inspection');assert.equal(before.service,instance.name);assert.ok(before.memoryMb>0);assert.ok(before.connections.total>=1);
    const recommendations=policy.mysqlRecommendations(before.facts);assert.ok(recommendations.some(r=>r.key==='performance_schema'));assert.ok(recommendations.some(r=>r.key==='innodb_log_buffer_size'));
    if(instance===target){
      // Exercise the same script invoked by local Manager's tuning API.
      const out=await native('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repository,'scripts/tune-database-memory.ps1'),'-Engine',instance.provider,'-ServiceName',instance.name,'-Settings',policy.tuningSettings(recommendations,['performance_schema','innodb_log_buffer_size'])]);assert.match(out.stdout,/RESULT /);
    }else{
      // Exercise the remote agent's real inspection, freshness check and tuning path.
      const result=await resource({action:'database-tune',connection,service:instance.name,port:instance.port,facts:before.facts,settings:policy.tuningSettings(recommendations,['performance_schema','innodb_log_buffer_size']),script,serviceScript});assert.equal(result.result.ok,true);
    }
    const variables=Object.fromEntries((await sql(instance,"SHOW GLOBAL VARIABLES WHERE Variable_name IN ('performance_schema','innodb_log_buffer_size')")).map(v=>[v.Variable_name,String(v.Value)]));assert.equal(variables.performance_schema,'OFF');assert.equal(variables.innodb_log_buffer_size,String(16*1024*1024));
    assert.equal((await sql(instance,'SELECT value FROM preservation_probe.values_to_keep WHERE id=1'))[0].value,'original fixture must survive');
    assert.deepEqual(await identity(peer),peerBefore,'Unselected peer service did not restart');assert.equal(await hash(peer.config),peerConfig,'Unselected peer config unchanged');
    assert.equal((await sql(peer,'SELECT value FROM preservation_probe.values_to_keep WHERE id=1'))[0].value,'original fixture must survive');
    const oldPid=(await identity(instance)).pid,stableConfig=await hash(instance.config);
    await assert.rejects(native('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repository,'scripts/tune-database-memory.ps1'),'-Engine',instance.provider,'-ServiceName',instance.name,'-Settings','port=3306']),/not one this script changes/);
    assert.equal((await identity(instance)).pid,oldPid);assert.equal(await hash(instance.config),stableConfig);
    await assert.rejects(resource({action:'database-tune',connection,service:instance.name,facts:before.facts,settings:'performance_schema=OFF',script,serviceScript}),/settings changed/);
    report.checks.push({engine:instance.provider,localOrRemote:instance===target?'local Manager tuning script':'remote agent tuning',customPaths:true,realSqlSettingsVerified:true,dataPreserved:true,peerUnchanged:true,invalidAndStaleRequestsRejected:true});
  }
  const listeners=JSON.parse(await ps("@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(33161,33162,33163)} | Select-Object LocalAddress,LocalPort)|ConvertTo-Json -Compress"));assert.ok(listeners.length>=3);assert.ok(listeners.every(l=>['127.0.0.1','::1'].includes(l.LocalAddress)));
  report.status='passed';report.privateListeners=true;
}
run().catch(error=>{report.error=error.message;console.error(error.message);process.exitCode=1}).finally(async()=>{await fs.mkdir(root+'/results',{recursive:true});await fs.writeFile(root+'/results/database-tuning.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));});
