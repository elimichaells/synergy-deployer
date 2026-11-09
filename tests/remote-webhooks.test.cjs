const test=require('node:test'),assert=require('node:assert/strict'),{createHmac}=require('node:crypto'),load=require('./server-module.cjs');
const policy=load('lib/git-provider-policy.ts',{}),{remotePush}=load('lib/remote-webhook-policy.ts',{'./git-provider-policy':policy});
test('remote pushes authenticate each provider, ignore deleted refs and retain the exact pushed commit',()=>{
  for(const provider of ['github','gitlab','gitea']){
    const secret='isolated-webhook-signature',payload={ref:'refs/heads/main',after:'a'.repeat(40),repository:{clone_url:'https://github.com/example/app.git'},project:{git_http_url:'https://gitlab.example/org/app.git'}},raw=JSON.stringify(payload);
    const headers=new Headers({[provider==='github'?'x-github-event':provider==='gitlab'?'x-gitlab-event':'x-gitea-event']:provider==='gitlab'?'Push Hook':'push',[provider==='github'?'x-hub-signature-256':provider==='gitlab'?'x-gitlab-token':'x-gitea-signature']:provider==='gitlab'?secret:(provider==='github'?'sha256=':'')+createHmac('sha256',secret).update(raw).digest('hex')});
    const push=remotePush(provider,raw,headers,secret);assert.equal(push.sha,payload.after);assert.equal(push.branch,'main');
    assert.throws(()=>remotePush(provider,raw,headers,'different secret'),/signature/);if(provider!=='gitlab')assert.throws(()=>remotePush(provider,raw+' ',headers,secret),/signature/);
    if(provider==='gitlab')assert.equal(remotePush(provider,JSON.stringify({...payload,deleted:true}),headers,secret),null);
  }
});

for(const provider of ['github','gitea','gitlab'])test(`${provider} remote webhook management changes only the scoped callback and keeps secrets private`,async()=>{
  const server='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',url=`https://manager.test/api/webhooks/remote/${server}/${id}`;
  const app={id,repo_url:'https://git.example/org/app',git_connection_id:'git',branch:'main',auto_deploy:false,webhook_ciphertext:null},requests=[];let released=0,reject=false,unlockFailure=false,repoChanged=false;
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const query=async(sql,args)=>{
    if(sql.startsWith('select * from remote_apps'))return{rows:args[0]===server&&args[1]===id?[{...app}]:[]};
    if(sql.startsWith('update remote_apps')){
      if(repoChanged&&sql.includes('and repo_url='))return{rowCount:0};
      if(sql.includes('webhook_ciphertext=$3'))app.webhook_ciphertext=args[2];
      if(sql.includes('webhook_ciphertext=null')){app.webhook_ciphertext=null;app.auto_deploy=false;}
      if(sql.includes('auto_deploy=$3'))app.auto_deploy=args[2];return{rowCount:1};
    }return{rows:[],rowCount:1};
  };
  const module=load('lib/remote-git-automation.ts',{
    '@/lib/api':{ApiError},'@/lib/db':{query,db:{connect:async()=>({query:async sql=>{if(unlockFailure&&sql.includes('pg_advisory_unlock'))throw Error('connection closed');return{rows:[{ok:true}]}},release:()=>released++})}},
    '@/lib/managed-servers':{ensureManagedServers:async()=>{},uuid:x=>x,queueRemoteDeploy:async()=>({id:'job'})},
    '@/lib/secret-crypto':{encryptSecret:x=>'encrypted:'+x,decryptSecret:x=>x.slice(10)},
    '@/lib/github-connections':{getGitConnection:async()=>({provider}),getGitHubConnectionToken:async()=> 'isolated-token'},
    '@/lib/git-provider-api':{gitApi:async(_host,_token,endpoint,options)=>{requests.push({endpoint,options});if(!options)return{ok:true,status:200,data:[{id:9,url:'https://someone-else.test/hook',config:{url:'https://someone-else.test/hook'}},{id:10,url,config:{url}}]};return{ok:!reject,status:reject?403:200,data:{}}}},
    '@/lib/git-provider-policy':{repositoryPath:()=> 'org/app',repositoryUrl:x=>x},'@/lib/manager-address':{managerUrl:()=> 'https://manager.test'},'@/lib/remote-webhook-policy':{remotePush:()=>null}
  });
  const connected=await module.changeRemoteGit(server,id,{action:'connect'},'admin');assert.equal(connected.secret,undefined);assert.ok(app.webhook_ciphertext.startsWith('encrypted:'));const mutation=requests.find(x=>x.options);assert.ok(mutation.endpoint.endsWith('/10'));assert.equal(mutation.options.method,provider==='gitlab'?'PUT':'PATCH');
  if(provider==='gitlab')assert.equal(mutation.options.body.enable_ssl_verification,true);else assert.equal(mutation.options.body.config.insecure_ssl,'0');
  await module.changeRemoteGit(server,id,{action:'disconnect'},'admin');assert.equal(app.webhook_ciphertext,null);assert.equal(requests.filter(x=>x.options?.method==='DELETE').length,1);assert.ok(requests.every(x=>!x.endpoint.endsWith('/9')));
  reject=true;await assert.rejects(module.changeRemoteGit(server,id,{action:'connect'},'admin'),/rejected/);assert.equal(app.webhook_ciphertext,null);
  reject=false;repoChanged=true;await assert.rejects(module.changeRemoteGit(server,id,{action:'connect'},'admin'),/repository changed/);assert.equal(app.webhook_ciphertext,null);
  await assert.rejects(module.remoteGitStatus('different-server',id),/not found/);
  unlockFailure=true;await assert.rejects(module.changeRemoteGit(server,id,{action:'auto',enabled:false},'admin'),/connection closed/);assert.equal(released,5);
});
test('remote webhook routes bound unauthenticated payloads and require admin same-origin configuration',async()=>{
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const api={ApiError,jsonError:e=>Response.json({error:e.message},{status:e.status||500})};let role='operator',calls=0;
  const mocks={'next/server':{NextResponse:Response},'@/lib/api':api,'@/lib/auth':{getSessionFromCookie:async()=>({id:'user',role})},'@/lib/rbac':load('lib/rbac.ts',{'./api':api}),'@/lib/request-body':load('lib/request-body.ts',{'@/lib/api':api}),'@/lib/update-maintenance':{updateProtected:(_label,f)=>f()},'@/lib/remote-git-automation':{remoteGitStatus:async()=>({}),changeRemoteGit:async()=>{calls++;return{}},receiveRemotePush:async()=>{calls++;return{status:'queued'}}}};
  const route=load('app/api/servers/[id]/apps/[appId]/git-automation/route.ts',mocks),context={params:Promise.resolve({id:'server',serverId:'server',appId:'app'})};
  const request=(body='{}',origin='https://manager.test')=>new Request('https://manager.test/api/test',{method:'POST',headers:{origin,host:'manager.test'},body});
  assert.equal((await route.POST(request(),context)).status,403);role='admin';assert.equal((await route.POST(request('{}','https://other.test'),context)).status,403);assert.equal(calls,0);
  const events=load('app/api/webhooks/remote/[serverId]/[appId]/route.ts',mocks);assert.equal((await events.POST(request('x'.repeat(2*1024*1024+1)),context)).status,413);assert.equal(calls,0);
});
