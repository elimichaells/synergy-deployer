'use strict';
const fs=require('node:fs/promises'),{randomUUID}=require('node:crypto'),assert=require('node:assert/strict'),load=require('../server-module.cjs'),agent=require('../../scripts/manager-agent.cjs');
module.exports=async function managerRemoval(t,applications){
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pg=require('pg'),schema='live_removal_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href});await admin.query(`create schema ${schema}`);
  const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema},public`,max:12}),query=(sql,args)=>pool.query(sql,args);
  t.after(async()=>{await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()});await query(await fs.readFile('db/schema.sql','utf8'));
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const api={ApiError},secret={encryptSecret:s=>'fixture:'+Buffer.from(s).toString('base64'),decryptSecret:s=>Buffer.from(s.slice(8),'base64').toString()},db={db:pool,query};
  const mocks={'@/lib/api':api,'@/lib/db':db,'@/lib/audit':{audit:async()=>{}},'@/lib/git-provider-policy':{},'@/lib/github-connections':{},'@/lib/remote-security-gate-policy':load('lib/remote-security-gate-policy.ts',{}),'@/lib/deployment-cache':{loadAuditExceptions:()=>[]},'@/lib/security-gate-policy':load('lib/security-gate-policy.ts',{}),'@/lib/remote-setup-policy':{},'@/lib/secret-crypto':secret,'@/scripts/manager-agent.cjs':agent};
  const managed=load('lib/managed-servers.ts',mocks),removal=load('lib/application-removal.ts',{'@/lib/api':api,'@/lib/db':db,'@/lib/managed-servers':managed,'@/lib/secret-crypto':secret});mocks['@/lib/application-removal']=removal;
  const actor=(await query("insert into users(email,name,password_hash) values('live-fixture@example.test','Fixture','unused') returning id")).rows[0].id,server=await managed.addServer({name:'Real process fixture',platform:process.platform},actor);
  await query('update managed_servers set enrolled_at=now(),last_seen_at=now(),metrics=$2 where id=$1',[server.id,JSON.stringify({capabilities:['application-control-v1','remote-console-v1'],apps:applications.map(s=>({id:s.app.id,status:'online'}))})]);
  for(const item of applications){const created=await managed.saveRemoteApp(server.id,null,item.app,actor);await query('update remote_apps set id=$2,live_commit=$3 where id=$1',[created.id,item.app.id,item.commit]);}
  return async(id,execute)=>{
    const review=await removal.reviewApplicationRemoval(server.id,id);assert.equal(review.blockers.length,0);
    await removal.removeApplication(server.id,id,{reviewToken:review.reviewToken,confirmationName:review.application.name,acknowledged:true},actor);
    assert.equal((await query('select 1 from remote_apps where id=$1',[id])).rowCount,1,'record stays until the agent acknowledges preservation');
    const {job}=await managed.claimJob(server.id);assert.equal(job.payload.action,'detach');assert.equal(job.payload.id,id);
    const result=await execute(job);await assert.rejects(managed.reportJob(server.id,{id:job.id,claimToken:'wrong-claim',status:'success',sequence:1,log:'Rejected fixture receipt',result}),e=>e.status===404);
    await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'success',sequence:1,log:'Preservation verified by the isolated live agent',result});
    assert.equal((await query('select 1 from remote_apps where id=$1',[id])).rowCount,0);assert.equal((await query('select 1 from removed_application_records where application_id=$1',[id])).rowCount,1);
    for(const item of applications.filter(a=>a.app.id!==id))assert.equal((await query('select 1 from remote_apps where id=$1',[item.app.id])).rowCount,1);
    return result;
  };
};
