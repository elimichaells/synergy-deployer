'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),agent=require('../../scripts/manager-agent.cjs'),storage=require('../../scripts/remote-storage-agent.cjs');
module.exports=async function liveDatabaseSwitch(t,lab,appId,workerId,stoppedId){
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pg=require('pg'),admin={provider:'postgresql',host:url.hostname,port:Number(url.port),username:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:'postgres',tls:false},control=new pg.Client(storage.connection(admin));await control.connect();
  const name='live_switch_'+randomUUID().replaceAll('-','');let role;
  await control.query(`create database "${name}"`);t.after(async()=>{try{await control.query(`drop database "${name}" with(force)`);if(role)await control.query(`drop role "${role}"`);}finally{await control.end();}});
  const connection={...admin,database:name},client=new pg.Client(storage.connection(connection));await client.connect();try{await client.query("create table receipts(id serial primary key,value text);insert into receipts(value) values('preserved')");}finally{await client.end();}
  const resource=input=>agent.infrastructureJob(lab.root,{payload:{action:'resource',resource:input,expiresAt:Date.now()+60000}},lab.tools,()=>{});
  const databaseUrl=`postgresql://${encodeURIComponent(admin.username)}:${encodeURIComponent(admin.password)}@127.0.0.1:${admin.port}/${name}`;
  await resource({action:'storage',operation:'sync-env',serviceId:appId,environment:{DATABASE_URL:databaseUrl},restart:true});
  const saved=(await agent.readJson(path.join(lab.root,'apps.json')))[appId],launch=await agent.readJson(path.join(path.dirname(saved.ecosystem),'launch.json'));
  // Refresh only the linked running worker so the before/after comparison uses
  // the live account. The stopped worker remains stopped throughout.
  await resource({action:'worker-restart',id:workerId});
  const manager=await require('./storage-change-manager.cjs')(t,[{id:appId,name:saved.app.name,commit:saved.commit,content:await fs.readFile(path.join(launch.cwd,'.env'),'utf8')}],connection),service=manager.services[0];
  await manager.changes.reviewRemoteDedicatedUser(manager.server.id,service,manager.actor);let job=await manager.claim();const review=await agent.infrastructureJob(lab.root,job,lab.tools,()=>{});await manager.report(job,'success',review);
  assert.deepEqual(review.plan.blockers,[]);role=review.plan.roleName;
  await manager.changes.changeRemoteDedicatedUser(manager.server.id,service,{confirm:true,review:review.plan.review},manager.actor);job=await manager.claim();const result=await agent.infrastructureJob(lab.root,job,lab.tools,()=>{});assert.equal(result.accepted,true);await manager.report(job,'success',result);
  const response=await(await fetch('http://127.0.0.1:'+saved.app.port)).json(),currentUrl=new URL(response.database);assert.equal(currentUrl.username,role);
  const limited=new pg.Client({connectionString:currentUrl.href});await limited.connect();try{assert.equal((await limited.query('select value from receipts')).rows[0].value,'preserved');await assert.rejects(limited.query('create role forbidden_live_fixture'),e=>e.code==='42501');}finally{await limited.end();}
  const worker=await agent.readJson(path.join(lab.root,'workers',workerId,'launch.json'));assert.equal(new URL(worker.env.DATABASE_URL).username,role);
  const output=await lab.pm(['jlist']),list=JSON.parse(output.slice(output.indexOf('[')));assert.ok(list.some(p=>p.name==='manager-worker-'+workerId&&p.pm2_env.status==='online'));assert.ok(!list.some(p=>p.name==='manager-worker-'+stoppedId&&p.pm2_env.status==='online'));
  assert.equal((await manager.storage.remoteStorageServices(manager.server.id))[0].username,role);
  const savedApp=(await manager.query('select env_names,env_ciphertext from remote_apps where id=$1',[appId])).rows[0];
  assert.ok(!savedApp.env_names.includes('PORT'));
  assert.equal(new URL(JSON.parse(manager.secret.decryptSecret(savedApp.env_ciphertext)).DATABASE_URL).username,role);
  // The stored user environment must still pass the real deployment validator.
  const next=await manager.managed.queueRemoteDeploy(manager.server.id,appId,manager.actor);
  await manager.managed.cancelQueuedJob(manager.server.id,next.id,manager.actor);
};
