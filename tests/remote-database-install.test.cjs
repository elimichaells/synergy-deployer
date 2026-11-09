'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{randomUUID,randomBytes}=require('node:crypto');
const load=require('./server-module.cjs'),agent=require('../scripts/manager-agent.cjs'),policy=require('../scripts/remote-service-policy.cjs');
test('SQL Server verifies custom client paths and refuses replacing an instance',()=>{
  const tools=load('lib/server-tool-catalog.ts',{}),discovery=load('lib/server-discovery.ts',{'./server-tool-catalog':tools});assert.equal(discovery.toolCompatible('sqlcmd','sqlcmd version 1.10.0'),true);assert.equal(discovery.toolCompatible('sqlcmd','unrelated 1.10.0'),false);
  for(const platform of ['win32','linux']){const file=platform==='win32'?'D:\\Institution SQL\\sqlcmd.exe':'/srv/institution sql/sqlcmd',inventory={platform,portsKnown:true,ports:[],services:[{name:platform==='win32'?'MSSQL$EXISTING':'mssql-server.service',executable:''}],tools:{sqlcmd:[{path:file,compatible:true}]}};policy.verifyServicePlan(policy.servicePlan({service:'sqlserver',mode:'reuse',path:file},platform),inventory);assert.throws(()=>policy.verifyServicePlan(policy.servicePlan({service:'sqlserver',mode:'install'},platform),inventory),platform==='win32'?/existing installation/:/Windows x64/);}
});
test('MongoDB installation refuses existing services, occupied ports and unsupported distributions',()=>{
  const tools=load('lib/server-tool-catalog.ts',{}),discovery=load('lib/server-discovery.ts',{'./server-tool-catalog':tools});assert.equal(discovery.toolCompatible('mongod','db version v8.0.34'),true);assert.equal(discovery.toolCompatible('mongod','unrelated 8.0.34'),false);
  for(const platform of ['win32','linux']){const file=platform==='win32'?'D:\\Existing MongoDB\\mongod.exe':'/srv/existing mongodb/mongod',inventory={platform,arch:'x64',distribution:{id:'ubuntu',version:'22.04'},portsKnown:true,ports:[27017],services:[{name:'MongoDB',executable:file}],tools:{mongod:[{path:file,compatible:true}]}};policy.verifyServicePlan(policy.servicePlan({service:'mongodb',mode:'reuse',path:file},platform),inventory);assert.throws(()=>policy.verifyServicePlan(policy.servicePlan({service:'mongodb',mode:'install',port:27018},platform),inventory),/existing installation/);}
  assert.throws(()=>policy.verifyServicePlan(policy.servicePlan({service:'mongodb',mode:'install'},'linux'),{platform:'linux',portsKnown:true,services:[],ports:[],tools:{mongod:[]},distribution:{id:'unsupported',version:'1'}}),/distribution/);
});
const engine=process.env.MANAGER_SERVICE_INSTALL_ENGINE||'mongodb';
test('disposable OS installs authenticated '+engine+', verifies restart persistence and preserves reuse',{skip:process.env.MANAGER_SERVICE_INSTALL_LAB!=='1',timeout:900000},async()=>{
  assert.ok(['mongodb','sqlserver','redis'].includes(engine));if(engine==='sqlserver')assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.ok(process.env.TEST_CADDY);assert.ok(process.env.TEST_PM2_PACKAGE_ROOT);
  const windows=process.platform==='win32',root=path.join(windows?process.env.ProgramData:'/opt','ManagerRuntimeLab-'+randomUUID()),toolsRoot=path.join(root,'tools'),agentRoot=path.join(root,'agent'),stage=path.join(root,'stage'),dataRoot=path.join(root,'services');await fs.mkdir(toolsRoot,{recursive:true});await fs.mkdir(agentRoot);await fs.mkdir(stage);
  const run=(file,args,options)=>agent.run(file,args,{timeout:180000,...options}),ps=script=>run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,FIXTURE_ROOT:root,FIXTURE_AGENT_ROOT:agentRoot}});
  // GitHub's Windows image ships an unrelated MongoDB service. Only on this
  // disposable hosted VM, remove that exact image service registration so the
  // real installer can exercise its missing-service path. Keep all its files.
  if(windows&&engine==='mongodb')await ps(`$service=Get-CimInstance Win32_Service -Filter "Name='MongoDB'";if($service){if($service.PathName -notmatch '^"?C:\\\\Program Files\\\\MongoDB\\\\Server\\\\[0-9.]+\\\\bin\\\\mongod.exe[" ]'){throw 'Unexpected hosted-image MongoDB path'};Stop-Service -Name MongoDB -ErrorAction Stop;& sc.exe delete MongoDB;if($LASTEXITCODE -ne 0){throw 'Could not clear disposable image service'}}`);
  const node=path.join(toolsRoot,windows?'node.exe':'node'),caddy=path.join(toolsRoot,windows?'caddy.exe':'caddy');await fs.copyFile(process.execPath,node);await fs.copyFile(process.env.TEST_CADDY,caddy);await fs.cp(path.dirname(process.env.TEST_PM2_PACKAGE_ROOT),path.join(toolsRoot,'node_modules'),{recursive:true});
  const git=(await run(windows?'where.exe':'which',['git'])).split(/\r?\n/)[0],pm2=path.join(toolsRoot,'node_modules/pm2/bin/pm2'),paths={node,git,caddy,pm2};
  await agent.atomicJson(path.join(agentRoot,'agent.json'),{enrolled:true,serverId:'11111111-1111-4111-8111-111111111111'});await agent.atomicJson(path.join(agentRoot,'tool-paths.json'),paths);await fs.writeFile(path.join(agentRoot,'manager-agent.cjs'),await require('../scripts/agent-bundle.cjs').agentBundle());
  if(windows)await ps("& icacls.exe $env:FIXTURE_ROOT /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Fixture permissions failed'}; & icacls.exe $env:FIXTURE_AGENT_ROOT /grant '*S-1-5-19:(OI)(CI)F' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Fixture agent permissions failed'}");
  else{assert.equal(process.getuid(),0);await run('useradd',['--system','--no-create-home','--shell','/usr/sbin/nologin','manager-agent']);await run('chmod',['-R','a+rX',root]);await run('chmod',['a+x',node,caddy]);await run('chown',['-R','manager-agent:manager-agent',agentRoot]);}
  for(const name of ['install-remote-service.ps1','install-remote-service.sh','install-remote-tool.cjs','initialize-remote-database.cjs','agent-runtime-loader.cjs','install-remote-sqlserver.ps1','offline-service.ps1','installer-offline.ps1','database-service.ps1'])await fs.writeFile(path.join(stage,name),(await fs.readFile(path.join(process.cwd(),'scripts',name),'utf8')).replaceAll('\r\n','\n'));
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  class ApiError extends Error{}const downloads=load('lib/remote-service-downloads.ts',{'./api':{ApiError},'./server-ssh':{installerDownloads:async()=>({node:{}})}});
  const plan={service:engine,mode:'install',port,agentRoot,dataRoot,serverId:'11111111-1111-4111-8111-111111111111',operationId:randomUUID(),databasePassword:(engine==='sqlserver'?'Mg!A1':'')+randomBytes(36).toString('hex'),downloads:await downloads.serviceDownloads(engine,process.platform,process.arch,{id:'ubuntu',version:'22.04'}),driverArchive:await require('../scripts/agent-postgres-runtime.cjs').packagePostgresRuntime(process.cwd(),[engine==='sqlserver'?'mssql':engine==='redis'?'redis':'mongodb'])},file=path.join(stage,'plan.json');await agent.atomicJson(file,plan);
  // Model an administrator SSH session, including ProgramFiles and the Windows
  // installer environment. Application jobs intentionally use a smaller env.
  const install=()=>run(windows?'powershell.exe':'bash',windows?['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(stage,'install-remote-service.ps1'),'-PlanFile',file]:[path.join(stage,'install-remote-service.sh'),file,process.execPath],{timeout:720000,env:process.env,secrets:[plan.databasePassword]});
  await install();const receipt=await agent.readJson(path.join(stage,'result.json'));assert.equal(receipt.status,'success');assert.equal(receipt.username,engine==='sqlserver'?'sa':engine==='redis'?'default':'manager_provisioner');assert.equal(receipt.port,port);
  if(engine==='redis'){
    const {createClient}=require('redis'),client=createClient({url:`redis://127.0.0.1:${port}`,username:'default',password:plan.databasePassword,socket:{connectTimeout:5000,reconnectStrategy:false}});client.on('error',()=>{});await client.connect();
    try{
      await client.set('fixture:preserved:site','Keep this data');const pid=async()=>(await client.info('server')).match(/process_id:(\d+)/)[1],original=await pid();
      await assert.rejects(install());assert.equal(await pid(),original,'refused installation must not restart Redis');
      await agent.atomicJson(file,{...plan,mode:'reuse',path:receipt.path,operationId:randomUUID()});await install();assert.equal(await pid(),original);assert.equal(await client.get('fixture:preserved:site'),'Keep this data');assert.equal((await agent.readJson(path.join(agentRoot,'tool-check.json'))).ok,true);
      const anonymous=createClient({url:`redis://127.0.0.1:${port}`,socket:{connectTimeout:3000,reconnectStrategy:false}});anonymous.on('error',()=>{});try{await assert.rejects(async()=>{await anonymous.connect();await anonymous.ping();});}finally{if(anonymous.isOpen)anonymous.destroy();}
    }finally{client.destroy();}return;
  }
  if(engine==='sqlserver'){
    const sql=require('mssql'),pool=await new sql.ConnectionPool({server:'127.0.0.1',port,user:'sa',password:plan.databasePassword,database:'master',options:{encrypt:true,trustServerCertificate:true}}).connect();
    try{
      await pool.request().query("CREATE DATABASE fixture_preserved");await pool.request().query("CREATE TABLE fixture_preserved.dbo.sites (id INT PRIMARY KEY,value VARCHAR(50)); INSERT fixture_preserved.dbo.sites VALUES (1,'Keep this data')");
      const pid=async()=>(await pool.request().query("SELECT SERVERPROPERTY('ProcessID') AS pid")).recordset[0].pid,original=await pid();
      await assert.rejects(install());assert.equal(await pid(),original,'refused install must not restart SQL Server');
      await agent.atomicJson(file,{...plan,mode:'reuse',path:receipt.path,operationId:randomUUID()});await install();assert.equal(await pid(),original);
      assert.equal((await pool.request().query('SELECT value FROM fixture_preserved.dbo.sites WHERE id=1')).recordset[0].value,'Keep this data');assert.equal((await agent.readJson(path.join(agentRoot,'tool-check.json'))).ok,true);
    }finally{await pool.close();}return;
  }
  const {MongoClient}=require('mongodb'),client=new MongoClient(`mongodb://127.0.0.1:${port}/?authSource=admin`,{auth:{username:receipt.username,password:plan.databasePassword},serverSelectionTimeoutMS:5000});await client.connect();
  try{await client.db('fixture_preserved').collection('sites').insertOne({_id:'existing',value:'Keep this data'});const pid=(await client.db('admin').command({serverStatus:1})).pid;await assert.rejects(install());assert.equal((await client.db('admin').command({serverStatus:1})).pid,pid,'refused installation must not stop the existing service');assert.equal((await client.db('fixture_preserved').collection('sites').findOne({_id:'existing'})).value,'Keep this data');
    await agent.atomicJson(file,{...plan,mode:'reuse',path:receipt.path,operationId:randomUUID()});await install();assert.equal((await client.db('admin').command({serverStatus:1})).pid,pid,'reuse must not restart the database');assert.equal((await agent.readJson(path.join(agentRoot,'tool-check.json'))).ok,true);
  }finally{await client.close();}
  // The hosted VM is disposable. No cleanup command targets any pre-existing
  // service; its existing-service guards were exercised above.
});
