'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const providers=require('../scripts/remote-storage-providers.cjs');
test('provider connection tests accept existing names without treating them as SQL identifiers',async()=>{
  let observed;
  await providers.execute('',{operation:'test',connection:{provider:'mysql',host:'127.0.0.1',port:3306,username:'name@server',database:'existing-database',password:'private'}},{},async()=>({createConnection:async options=>{observed=options;return{query:async()=>[[]],end:async()=>{}}}}));
  assert.equal(observed.database,'existing-database');assert.equal(observed.user,'name@server');
});
test('standalone agent provisions and rotates disposable MySQL, MariaDB, MongoDB, SQL Server and connects Redis',{skip:process.env.MANAGER_STORAGE_PROVIDER_LAB!=='1',timeout:600000},async t=>{
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.platform,'linux');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-storage-providers-'));t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-storage-providers-'));await fs.rm(root,{recursive:true,force:true})});
  const filename=path.join(root,'agent.cjs');await fs.writeFile(filename,await require('../scripts/agent-bundle.cjs').agentBundle());const agent=require(filename);
  const engines=[['mysql',33161,'root','mysql','mysql2'],['mariadb',33162,'root','mysql','mysql2'],['mongodb',27027,'fixture_admin','admin','mongodb'],['sqlserver',11433,'sa','master','mssql'],['redis',16379,'','0','redis']];
  for(const [provider,port,username,database,driver] of engines)await t.test(provider,async()=>{
    const administrator={provider,host:'127.0.0.1',port,username,database,password:'Fixture-Storage-Password-2026',tls:false},serviceId=randomUUID();
    const archive=await require('../scripts/agent-postgres-runtime.cjs').packagePostgresRuntime(process.cwd(),[driver]);
    const run=input=>agent.infrastructureJob(root,{payload:{action:'resource',resource:{action:'storage',serviceId,connection:administrator,driverArchive:archive,...input},expiresAt:Date.now()+60000}},{},()=>{});
    let ready=false,last;for(let attempt=0;attempt<12;attempt++){try{await run({operation:'test'});ready=true;break}catch(error){last=error;await new Promise(resolve=>setTimeout(resolve,2000))}}if(!ready)throw last;
    if(provider==='redis'){assert.equal((await run({operation:'test',connection:{...administrator,database:'2'}})).connected,true);return}
    const suffix=randomUUID().replaceAll('-','').slice(0,16),app={...administrator,database:'fixture_'+suffix,username:'app_'+suffix,password:randomUUID()+randomUUID()};
    const result=await run({operation:'provision',connection:app,administrator});assert.equal(result.connected,true);
    await assert.rejects(run({operation:'provision',connection:app,administrator}),/already exists/);
    assert.equal((await run({operation:'test',connection:app})).connected,true);
    const changed=randomUUID()+randomUUID();assert.equal((await run({operation:'rotate',connection:app,administrator,password:changed})).rotated,true);
    await assert.rejects(run({operation:'test',connection:app}),error=>!error.message.includes(app.password));
    assert.equal((await run({operation:'test',connection:{...app,password:changed}})).connected,true);
    await assert.rejects(run({operation:'rotate',connection:administrator,administrator,password:changed}),/administrator|dedicated/);
    assert.equal((await run({operation:'test'})).connected,true,'administrator was preserved');
  });
});
