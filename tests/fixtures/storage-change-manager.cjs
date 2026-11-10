'use strict';
const fs=require('node:fs/promises'),{randomUUID}=require('node:crypto'),assert=require('node:assert/strict'),load=require('../server-module.cjs'),agent=require('../../scripts/manager-agent.cjs'),resources=require('../../scripts/manager-agent-resources.cjs');
module.exports=async function fixture(t,applications,connection,administrator=connection){
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pg=require('pg'),schema='storage_change_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href});await admin.query(`create schema ${schema}`);
  const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema},public`,max:12}),query=(sql,args)=>pool.query(sql,args),db={db:pool,query};
  t.after(async()=>{await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()});await query(await fs.readFile('db/schema.sql','utf8'));
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const api={ApiError};process.env.MANAGER_ENCRYPTION_KEY='isolated-storage-change-key';const secret=load('lib/secret-crypto.ts',{}),envText=load('lib/environment-text.ts',{});
  const mocks={'@/lib/api':api,'@/lib/db':db,'@/lib/audit':{audit:async()=>{}},'@/lib/git-provider-policy':{},'@/lib/github-connections':{},'@/lib/remote-security-gate-policy':load('lib/remote-security-gate-policy.ts',{}),'@/lib/deployment-cache':{loadAuditExceptions:()=>[]},'@/lib/security-gate-policy':load('lib/security-gate-policy.ts',{}),'@/lib/remote-setup-policy':{},'@/lib/secret-crypto':secret,'@/scripts/manager-agent.cjs':agent,'@/lib/environment-text':envText};
  const managed=load('lib/managed-servers.ts',mocks);mocks['@/lib/managed-servers']=managed;
  const environment=load('lib/remote-environment.ts',mocks),res=load('lib/remote-resources.ts',{'./api':api,'./db':db,'./secret-crypto':secret,'./managed-servers':managed,'./server-memory-policy':load('lib/server-memory-policy.ts',{}),'@/scripts/manager-agent-resources.cjs':resources});
  const storageMocks={'./api':api,'./db':db,'./secret-crypto':secret,'./managed-servers':managed,'./remote-resources':res,'./remote-environment':environment,'./environment-text':envText,'./server-database-policy':load('lib/server-database-policy.ts',{}),'./database-discovery-policy':load('lib/database-discovery-policy.ts',{}),'./cron-jobs':{}};
  const storage=load('lib/remote-storage.ts',storageMocks);storageMocks['./remote-storage']=storage;
  const changes=load('lib/remote-storage-changes.ts',storageMocks);storageMocks['./remote-storage-changes']=changes;mocks['@/lib/remote-storage']=storage;mocks['./remote-storage']=storage;
  const migrations=load('lib/remote-storage-migrations.ts',storageMocks);storageMocks['./remote-storage-migrations']=migrations;const moves=load('lib/remote-storage-move.ts',storageMocks);storageMocks['./remote-storage-move']=moves;
  const removal=load('lib/application-removal.ts',mocks),serverRemoval=load('lib/server-removal.ts',mocks);mocks['@/lib/application-removal']=removal;
  storageMocks['./remote-storage-discovery']={discoverRemoteStorage:async()=>[]};
  const servers=load('lib/remote-storage-servers.ts',storageMocks);
  const actor=(await query("insert into users(email,name,password_hash) values('switch-fixture@example.test','Fixture','unused') returning id")).rows[0].id,server=await managed.addServer({name:'Switch fixture',platform:process.platform},actor);
  await query('update managed_servers set enrolled_at=now(),last_seen_at=now(),metrics=$2 where id=$1',[server.id,JSON.stringify({capabilities:['application-control-v1','remote-resources-v1','remote-console-v1','storage-control-v1'],apps:applications.map(a=>({id:a.id,status:'online'}))})]);
  const connectionId=(await query("insert into remote_storage_connections(server_id,name,provider,host,port,username,password_ciphertext,provisioning_enabled,last_status) values($1,'Isolated PostgreSQL','postgresql',$2,$3,$4,$5,true,'healthy') returning id",[server.id,connection.host,connection.port,administrator.username,secret.encryptSecret(administrator.password)])).rows[0].id;
  const services=[];
  for(const [n,app] of applications.entries()){
    const environment=Object.fromEntries(Object.entries(envText.parseEnvironmentText(app.content)).filter(([key])=>!['PORT','HOST','HOSTNAME','PATH','NODE_ENV','NODE_OPTIONS'].includes(key)&&!/^(MANAGER_AGENT_|PM2_|GIT_|NODE_EXTRA_CA_CERTS$)/i.test(key)));
    const created=await managed.saveRemoteApp(server.id,null,{name:app.name,repo_url:'https://github.com/fixture/application',branch:'main',port:3400+n,start_cmd:'node app.cjs',install_cmd:'',build_cmd:'',access_mode:'lan',hostname:`switch${n}.example.test`,environment},actor);
    await query('update remote_apps set id=$2,live_commit=$3,storage_catalog_enabled=true where id=$1',[created.id,app.id,app.commit]);
    const service=(await query("insert into remote_storage_services(server_id,app_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,application_primary,status) values($1,$2,$3,'primary',$4,$5,$6,'PRIMARY',true,'ready') returning id",[server.id,app.id,connectionId,connection.database,connection.username,secret.encryptSecret(connection.password)])).rows[0];services.push(service.id);
  }
  const report=async(job,status,result)=>managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status,sequence:1,log:'Isolated storage operation',result});
  return {query,managed,changes,moves,migrations,storage,servers,environment,removal,serverRemoval,server,actor,services,secret,report,claim:async()=>{const {job}=await managed.claimJob(server.id);assert.ok(job);return job;}};
};
