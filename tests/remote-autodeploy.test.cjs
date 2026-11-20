const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),load=require('./server-module.cjs');
class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
const api={ApiError};

for(const provider of ['github','gitea','gitlab'])test(`${provider}: auto-deploy persists only a confirmed push webhook and remains reversible on provider failure`,async()=>{
  const server=randomUUID(),id=randomUUID(),app={id,repo_url:'https://git.example/org/app',git_connection_id:randomUUID(),branch:'main',auto_deploy:false,webhook_ciphertext:null,guided_setup:true,setup_completed_at:new Date()};
  let enabled=true,providerFails=false,credentialsFail=false,concurrentChange=false,existing=null;const mutations=[];
  const query=async(sql,args)=>{
    if(sql.startsWith('select * from remote_apps'))return{rows:args[0]===server&&args[1]===id?[{...app}]:[]};
    if(sql.startsWith('select id from managed_servers'))return{rowCount:enabled?1:0};
    if(sql.startsWith('update remote_apps')){
      if(sql.includes('and repo_url=')&&concurrentChange)return{rowCount:0};
      if(sql.includes('webhook_ciphertext=$3'))app.webhook_ciphertext=args[2];
      if(sql.includes('auto_deploy=true'))app.auto_deploy=true;
      if(sql.includes('auto_deploy=$3'))app.auto_deploy=args[2];
      return{rowCount:1};
    }return{rows:[],rowCount:1};
  };
  const automation=load('lib/remote-git-automation.ts',{
    '@/lib/api':api,'@/lib/db':{query,db:{connect:async()=>({query:async()=>({rows:[{ok:true}]}),release(){}})}},
    '@/lib/managed-servers':{ensureManagedServers:async()=>{},uuid:x=>x},'@/lib/secret-crypto':{encryptSecret:x=>'encrypted:'+x,decryptSecret:x=>x.slice(10)},
    '@/lib/github-connections':{getGitConnection:async()=>{if(credentialsFail)throw Error('Git connection unavailable');return{provider}},getGitHubConnectionToken:async()=> 'fixture-token'},
    '@/lib/git-provider-policy':{repositoryPath:()=> 'org/app'},'@/lib/manager-address':{managerUrl:()=> 'https://manager.example'},'@/lib/remote-webhook-policy':{},
    '@/lib/git-provider-api':{gitApi:async(_host,_token,endpoint,options)=>{
      if(!options)return{ok:true,data:existing?[existing]:[]};
      // The old state is still disabled while the external provider is being changed.
      assert.equal(app.auto_deploy,false);mutations.push({endpoint,...options});
      if(providerFails)return{ok:false,status:403};
      existing={id:42,...options.body};return{ok:true,status:201,data:existing};
    }}
  });
  providerFails=true;await assert.rejects(automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor'),/rejected/);
  assert.equal(app.auto_deploy,false);assert.equal(app.webhook_ciphertext,null);
  providerFails=false;const result=await automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor');
  assert.equal(result.autoDeploy,true);assert.equal(result.installed,true);assert.equal(result.secret,undefined);assert.ok(app.webhook_ciphertext.startsWith('encrypted:'));
  const created=mutations.at(-1);assert.equal(created.method,'POST');
  if(provider==='gitlab'){assert.equal(created.body.push_events,true);assert.equal(created.body.enable_ssl_verification,true)}else{assert.deepEqual(created.body.events,['push']);assert.equal(created.body.active,true);assert.equal(created.body.config.insecure_ssl,'0')}
  credentialsFail=true;await automation.changeRemoteGit(server,id,{action:'auto',enabled:false},'actor');assert.equal(app.auto_deploy,false);
  credentialsFail=false;const cipher=app.webhook_ciphertext;await automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor');assert.equal(app.webhook_ciphertext,cipher);assert.match(mutations.at(-1).endpoint,/\/42$/);
  await automation.changeRemoteGit(server,id,{action:'auto',enabled:false},'actor');
  const count=mutations.length;app.setup_completed_at=null;await assert.rejects(automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor'),/Finish application setup/);
  app.setup_completed_at=new Date();enabled=false;await assert.rejects(automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor'),/Reconnect/);assert.equal(mutations.length,count);
  enabled=true;concurrentChange=true;await assert.rejects(automation.changeRemoteGit(server,id,{action:'auto',enabled:true},'actor'),/changed/);assert.equal(app.auto_deploy,false);assert.equal(app.webhook_ciphertext,cipher);
  await assert.rejects(automation.changeRemoteGit(server,id,{action:'auto',enabled:'true'},'actor'),/Choose whether/);
});

test('remote auto-deploy connects, persists, authenticates, queues and deduplicates in isolated PostgreSQL',{skip:!process.env.MANAGER_REMOTE_TEST_DATABASE_URL},async t=>{
  const url=new URL(process.env.MANAGER_REMOTE_TEST_DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/manager_remote_test_/);
  const pool=new(require('pg').Pool)({connectionString:url.href}),query=(sql,args)=>pool.query(sql,args);t.after(()=>pool.end());
  await query('create extension if not exists pgcrypto;create table if not exists users(id uuid primary key);create table if not exists github_connections(id uuid primary key);create table if not exists audit_logs(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),action text,resource text,details jsonb,created_at timestamptz default now())');
  const actor=randomUUID(),connection=randomUUID();await query('insert into users(id) values($1)',[actor]);await query('insert into github_connections(id) values($1)',[connection]);process.env.MANAGER_ENCRYPTION_KEY='disposable-autodeploy-integration';
  const crypto=load('lib/secret-crypto.ts',{}),policy=load('lib/git-provider-policy.ts',{}),agent=require('../scripts/manager-agent.cjs');
  const mocks={'@/lib/api':api,'@/lib/db':{db:pool,query},'@/lib/audit':{audit:async()=>{}},'@/lib/secret-crypto':crypto,'@/lib/github-connections':{getGitConnection:async()=>({provider:'github',base_url:'https://github.com'}),getGitHubConnectionToken:async()=> 'fixture-token'},'@/lib/git-provider-policy':policy,'@/lib/remote-setup-policy':load('lib/remote-setup-policy.ts',{}),'@/scripts/manager-agent.cjs':agent,'@/lib/remote-security-gate-policy':load('lib/remote-security-gate-policy.ts',{}),'@/lib/security-gate-policy':load('lib/security-gate-policy.ts',{}),'@/lib/deployment-cache':{loadAuditExceptions:()=>[]}};
  const managed=load('lib/managed-servers.ts',mocks);mocks['@/lib/managed-servers']=managed;
  const server=await managed.addServer({name:'Disposable auto-deploy server',platform:'linux'},actor);
  await query("update managed_servers set enrolled_at=now(),last_seen_at=now(),metrics=jsonb_build_object('capabilities',jsonb_build_array('application-control-v1')) where id=$1",[server.id]);
  const app=await managed.saveRemoteApp(server.id,null,{name:'Fixture',repo_url:'https://github.com/example/fixture',branch:'main',git_connection_id:connection,start_cmd:'npm start',port:45172,health_path:'/',access_mode:'lan',hostname:'autodeploy.fixture.example'},actor);
  let rejected=true,hook=null;
  mocks['@/lib/git-provider-api']={gitApi:async(_host,_token,_endpoint,options)=>!options?{ok:true,data:hook?[hook]:[]}:rejected?{ok:false,status:403}:(hook={id:1,...options.body},{ok:true,status:201,data:hook})};
  mocks['@/lib/manager-address']={managerUrl:()=> 'https://manager.fixture.example'};mocks['@/lib/remote-webhook-policy']=load('lib/remote-webhook-policy.ts',{'./git-provider-policy':policy});
  const automation=load('lib/remote-git-automation.ts',mocks);
  await assert.rejects(automation.changeRemoteGit(server.id,app.id,{action:'auto',enabled:true},actor),/rejected/);
  let stored=(await query('select * from remote_apps where id=$1',[app.id])).rows[0];assert.equal(stored.auto_deploy,false);assert.equal(stored.webhook_ciphertext,null);
  rejected=false;await automation.changeRemoteGit(server.id,app.id,{action:'auto',enabled:true},actor);
  stored=(await query('select * from remote_apps where id=$1',[app.id])).rows[0];assert.equal(stored.auto_deploy,true);assert.equal(stored.webhook_user_id,actor);assert.notEqual(stored.webhook_ciphertext,hook.config.secret);assert.equal(crypto.decryptSecret(stored.webhook_ciphertext),hook.config.secret);
  const raw=JSON.stringify({ref:'refs/heads/main',after:'b'.repeat(40),repository:{clone_url:'https://github.com/example/fixture.git'}}),headers=new Headers({'x-github-event':'push','x-hub-signature-256':'sha256='+require('node:crypto').createHmac('sha256',hook.config.secret).update(raw).digest('hex')});
  const first=await automation.receiveRemotePush(server.id,app.id,raw,headers),second=await automation.receiveRemotePush(server.id,app.id,raw,headers);assert.equal(first.deploymentId,second.deploymentId);
  const job=(await managed.claimJob(server.id)).job;assert.equal(job.id,first.deploymentId);assert.equal(job.payload.commitSha,'b'.repeat(40));assert.equal(job.payload.id,app.id);
  const nextRaw=raw.replace('b'.repeat(40),'c'.repeat(40)),nextHeaders=new Headers({'x-github-event':'push','x-hub-signature-256':'sha256='+require('node:crypto').createHmac('sha256',hook.config.secret).update(nextRaw).digest('hex')});
  const next=await automation.receiveRemotePush(server.id,app.id,nextRaw,nextHeaders);assert.notEqual(next.deploymentId,job.id);assert.equal((await automation.receiveRemotePush(server.id,app.id,nextRaw,nextHeaders)).deploymentId,next.deploymentId);
  assert.equal((await query('select status from remote_job_history where id=$1',[next.deploymentId])).rows[0].status,'queued');assert.equal((await managed.claimJob(server.id)).job.id,job.id);
  assert.equal((await query("select count(*)::int n from remote_jobs where app_id=$1 and status in ('queued','running')",[app.id])).rows[0].n,1);
  assert.ok((await managed.serverDetail(server.id)).jobs.some(row=>row.id===next.deploymentId&&row.status==='queued'));
  assert.ok((await managed.remoteDeploymentHistory(server.id,{appId:app.id})).jobs.some(row=>row.id===next.deploymentId));
  await assert.rejects(managed.queueRemoteDeploy(server.id,app.id,actor),/current application or storage operation/);
  await managed.reportJob(server.id,{id:job.id,claimToken:job.claimToken,status:'failed',sequence:1,log:'Disposable test complete'});
  const nextJob=(await managed.claimJob(server.id)).job;assert.equal(nextJob.id,next.deploymentId);assert.equal(nextJob.payload.commitSha,'c'.repeat(40));await managed.reportJob(server.id,{id:nextJob.id,claimToken:nextJob.claimToken,status:'failed',sequence:1,log:'Second disposable push complete'});
  const push=async letter=>{const body=raw.replace('b'.repeat(40),letter.repeat(40)),signed=new Headers({'x-github-event':'push','x-hub-signature-256':'sha256='+require('node:crypto').createHmac('sha256',hook.config.secret).update(body).digest('hex')});return automation.receiveRemotePush(server.id,app.id,body,signed)};
  const queued=await push('e'),waiting=await push('f'),cancelled=await push('1');await managed.cancelQueuedJob(server.id,cancelled.deploymentId,actor);
  assert.equal((await query('select status,payload_ciphertext from remote_jobs where id=$1',[cancelled.deploymentId])).rows[0].status,'cancelled');assert.equal((await query('select 1 from remote_webhook_queue where id=$1',[cancelled.deploymentId])).rowCount,0);
  await managed.cancelQueuedJob(server.id,queued.deploymentId,actor);const advanced=(await managed.claimJob(server.id)).job;assert.equal(advanced.id,waiting.deploymentId);assert.equal(advanced.payload.commitSha,'f'.repeat(40));await managed.reportJob(server.id,{id:advanced.id,claimToken:advanced.claimToken,status:'failed',sequence:1,log:'Cancellation advanced exactly one waiting push'});
  const revokeFirst=await push('2'),revokeWaiting=await push('3');await managed.changeServer(server.id,'revoke',actor);
  const revoked=(await query('select status,payload_ciphertext from remote_jobs where id=any($1::uuid[])',[[revokeFirst.deploymentId,revokeWaiting.deploymentId]])).rows;assert.equal(revoked.length,2);assert.ok(revoked.every(row=>row.status==='cancelled'&&row.payload_ciphertext===null));assert.equal((await query('select 1 from remote_webhook_queue where server_id=$1',[server.id])).rowCount,0);
  await query('update managed_servers set enabled=true where id=$1',[server.id]);
  const manual=await managed.queueRemoteDeploy(server.id,app.id,actor),manualJob=(await managed.claimJob(server.id)).job;assert.equal(manual.id,manualJob.id);const echo=await push('4');
  await managed.reportJob(server.id,{id:manualJob.id,claimToken:manualJob.claimToken,status:'success',securityStatus:'passed',sequence:1,log:'Release already includes this pushed commit',commitSha:'4'.repeat(40)});
  const skipped=(await query('select status,log,payload_ciphertext from remote_jobs where id=$1',[echo.deploymentId])).rows[0];assert.equal(skipped.status,'cancelled');assert.equal(skipped.payload_ciphertext,null);assert.match(skipped.log,/already live/);assert.equal((await managed.claimJob(server.id)).job,null);
  const blockedRaw=raw.replace('b'.repeat(40),'d'.repeat(40)),blockedHeaders=new Headers({'x-github-event':'push','x-hub-signature-256':'sha256='+require('node:crypto').createHmac('sha256',hook.config.secret).update(blockedRaw).digest('hex')});
  for(const kind of ['inspect','console']){
    const blocker=(await query("insert into remote_jobs(server_id,app_id,user_id,kind,payload_ciphertext) values($1,$2,$3,$4,$5) returning id",[server.id,app.id,actor,kind,crypto.encryptSecret('{}')])).rows[0].id;
    await assert.rejects(automation.receiveRemotePush(server.id,app.id,blockedRaw,blockedHeaders),/current application or storage operation/);await query('delete from remote_jobs where id=$1',[blocker]);
  }
  const storageBlocker=(await query("insert into remote_jobs(server_id,user_id,kind,operation_type,resource_action,payload_ciphertext) values($1,$2,'console','infrastructure','storage',$3) returning id",[server.id,actor,crypto.encryptSecret('{}')])).rows[0].id;
  await assert.rejects(automation.receiveRemotePush(server.id,app.id,blockedRaw,blockedHeaders),/current application or storage operation/);await query('delete from remote_jobs where id=$1',[storageBlocker]);
  await automation.changeRemoteGit(server.id,app.id,{action:'auto',enabled:false},actor);assert.equal((await automation.receiveRemotePush(server.id,app.id,raw,headers)).status,'ignored');
  await automation.changeRemoteGit(server.id,app.id,{action:'auto',enabled:true},actor);
  const saved=(await managed.serverDetail(server.id)).apps.find(row=>row.id===app.id);
  await managed.saveRemoteApp(server.id,app.id,{...saved,repo_url:'https://github.com/example/changed'},actor);
  stored=(await query('select * from remote_apps where id=$1',[app.id])).rows[0];assert.equal(stored.auto_deploy,false);assert.equal(stored.webhook_ciphertext,null);assert.equal(stored.webhook_user_id,null);
  await query('update remote_apps set guided_setup=true,setup_completed_at=null where id=$1',[app.id]);await assert.rejects(automation.changeRemoteGit(server.id,app.id,{action:'auto',enabled:true},actor),/Finish application setup/);
  await query("update managed_servers set metrics=jsonb_build_object('capabilities',jsonb_build_array('application-control-v1','guided-setup-v1')) where id=$1",[server.id]);
  mocks['@/lib/remote-setup-policy']=load('lib/remote-setup-policy.ts',{});mocks['@/lib/project-setup-policy']={SETUP_STEPS:['repository','runtime','database','environment','domain','review']};
  const setup=load('lib/remote-app-setup.ts',mocks);
  await query('update remote_apps set auto_deploy=true,webhook_ciphertext=$2,webhook_user_id=$3,setup_completed_at=now() where id=$1',[app.id,stored.webhook_ciphertext||crypto.encryptSecret('old-source-secret'),actor]);
  await setup.changeRemoteSetup(server.id,app.id,{action:'inspect',name:'Renamed fixture',repo_url:'https://github.com/example/another',git_connection_id:null,branch:'develop'},actor);
  stored=(await query('select * from remote_apps where id=$1',[app.id])).rows[0];assert.equal(stored.name,'Renamed fixture');assert.equal(stored.repo_url,'https://github.com/example/another');assert.equal(stored.branch,'develop');assert.equal(stored.git_connection_id,null);assert.equal(stored.setup_completed_at,null);assert.equal(stored.auto_deploy,false);assert.equal(stored.webhook_ciphertext,null);
  const inspection=(await managed.claimJob(server.id)).job;assert.equal(inspection.kind,'inspect');assert.equal(inspection.payload.repo_url,stored.repo_url);assert.equal(inspection.payload.git,null);
  await managed.reportJob(server.id,{id:inspection.id,claimToken:inspection.claimToken,status:'failed',sequence:1,log:'Disposable inspection complete'});
  await setup.changeRemoteSetup(server.id,app.id,{action:'save',step:'runtime',pre_deploy_cmd:'echo before',post_deploy_cmd:'echo after'},actor);
  const snapshot=await setup.remoteSetup(server.id,app.id);assert.equal(snapshot.app.pre_deploy_cmd,'echo before');assert.equal(snapshot.app.post_deploy_cmd,'echo after');
});
