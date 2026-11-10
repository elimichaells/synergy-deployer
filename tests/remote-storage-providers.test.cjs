'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const providers=require('../scripts/remote-storage-providers.cjs');
test('provider connection tests accept existing names without treating them as SQL identifiers',async()=>{
  let observed;
  await providers.execute('',{operation:'test',connection:{provider:'mysql',host:'127.0.0.1',port:3306,username:'name@server',database:'existing-database',password:'private'}},{},async()=>({createConnection:async options=>{observed=options;return{query:async()=>[[]],end:async()=>{}}}}));
  assert.equal(observed.database,'existing-database');assert.equal(observed.user,'name@server');
});
test('MySQL account creation and rotation remain limited to named loopback addresses',async()=>{
  const calls=[],d={provider:'mysql',host:'127.0.0.1',port:3306,username:'fixture_app',database:'fixture_database',password:'fixture-private-password'},administrator={...d,username:'fixture_admin'};let hosts=['localhost','127.0.0.1','::1'];
  const driver=async()=>({createConnection:async()=>({query:async(options,args)=>{calls.push({sql:options.sql,args});return[options.sql.startsWith('select host')?hosts.map(account_host=>({account_host})):[]]},end:async()=>{}})});
  await providers.execute('',{operation:'provision',connection:d,administrator},{},driver);
  const create=calls.find(c=>c.sql.startsWith('create user'));assert.deepEqual(create.args,hosts.flatMap(host=>[d.username,host,d.password]));
  assert.deepEqual(calls.filter(c=>c.sql.startsWith('grant')).map(c=>c.args[1]),hosts);
  await providers.execute('',{operation:'rotate',connection:d,administrator,password:'replacement-fixture-password'},{},driver);
  assert.deepEqual(calls.find(c=>c.sql.startsWith('alter user')).args,hosts.flatMap(host=>[d.username,host,'replacement-fixture-password']));
  hosts.push('%');const before=calls.filter(c=>c.sql.startsWith('alter user')).length;
  await assert.rejects(providers.execute('',{operation:'rotate',connection:d,administrator,password:'another-fixture-password'},{},driver),/dedicated local/);
  assert.equal(calls.filter(c=>c.sql.startsWith('alter user')).length,before);
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
    if(provider==='mongodb'){assert.equal((await run({operation:'test',connection:{...app,password:changed,database:'admin',authSource:app.database}})).connected,true);await assert.rejects(run({operation:'test',connection:{...app,password:changed,authSource:'admin'}}));}
    await assert.rejects(run({operation:'rotate',connection:administrator,administrator,password:changed}),/administrator|dedicated/);
    assert.equal((await run({operation:'test'})).connected,true,'administrator was preserved');
  });
});
