const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const load = require('./server-module.cjs');
const policy = require('../lib/git-provider-policy.ts');
const api = require('../lib/git-provider-api.ts');
const paths = require('../lib/paths.ts');
class ApiError extends Error { constructor(message,status){super(message);this.status=status;} }
const noDb = { query: async () => { throw new Error('Unexpected database access'); } };
function connections(query=noDb.query) {
 return load('lib/github-connections.ts', {'@/lib/api':{ApiError},'@/lib/db':{query},'@/lib/settings':{getSetting:async()=>'',updateSettings:async()=>{}},'./git-provider-policy':policy,'./git-provider-api':api});
}
function webhooks(query=noDb.query, extra={}) {
 return load('lib/git-webhooks.ts', {'@/lib/api':{ApiError},'@/lib/db':{query},'./github-connections':{},'./git-provider-api':api,'./git-provider-policy':policy,'./manager-address':{managerUrl:()=> 'https://deploy.institution.test'},'./github-webhooks':{},...extra});
}

test('self-hosted instances accept ports, subpaths and GitLab nested groups, with exact host boundaries',()=>{
 for (const provider of ['gitlab','gitea']) {
  const host=policy.gitHost(provider,'https://git.institution.test:8443/code/');
  assert.equal(policy.repositoryPath('https://git.institution.test:8443/code/team/app.git',host),'team/app');
  for(const url of ['https://git.institution.test.evil:8443/code/team/app','https://git.institution.test:8443/other/team/app','https://git.institution.test:8443/code2/team/app','https://github.com/team/app']) assert.throws(()=>policy.repositoryPath(url,host));
 }
 assert.equal(policy.repositoryPath('https://git.local/a/b/c.git',policy.gitHost('gitlab','https://git.local')),'a/b/c');
 assert.throws(()=>policy.repositoryPath('https://git.local/a/b/c.git',policy.gitHost('gitea','https://git.local')));
 for(const url of ['http://git.local/a/b','https://user:pass@git.local/a/b','https://git.local/a/b?token=x','https://git.local/a/../b','https://git.local/a/%2e%2e/b','https://git.local/a/b;whoami','file:///C:/repo','git@git.local:a/b']) assert.throws(()=>policy.repositoryUrl(url),url);
 assert.throws(()=>policy.gitHost('github','https://git.local'));
});

test('stored tokens survive a fresh module with the same server key and fail with a different key',()=>{
 const previous=process.env.JWT_SECRET, override=process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY;
 try {
  delete process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY;process.env.JWT_SECRET='fixture-persisted-server-key';
  const encrypted=connections().encryptToken('fixture-token-secret');
  assert.ok(!encrypted.includes('fixture-token-secret'));
  assert.equal(connections().decryptToken(encrypted),'fixture-token-secret');
  process.env.JWT_SECRET='different-server-key';assert.throws(()=>connections().decryptToken(encrypted));
 } finally {if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;if(override===undefined)delete process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY;else process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY=override;}
});

test('connection creation never returns encrypted or plaintext credentials and preserves provider metadata',async()=>{
 let saved;
 const module=load('lib/github-connections.ts',{'@/lib/api':{ApiError},'@/lib/db':{query:async(sql,params)=>{
  if(sql.includes('insert into github_connections')){saved=params;return {rows:[{id:'fixture'}]};}
  if(sql.includes('select c.id'))return {rows:[{id:'fixture',provider:'gitlab',base_url:'https://git.local',name:'Institution'}]};
  return {rows:[]};
 }},'@/lib/settings':{},'./git-provider-policy':policy,'./git-provider-api':{validateGitCa:api.validateGitCa,inspectGitToken:async()=>({account:{login:'bot'},scopes:[]})}});
 const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='fixture-key';
 try{const result=await module.createGitHubConnection('Institution','fixture-token',null,{provider:'gitlab',baseUrl:'https://git.local'});assert.equal(result.provider,'gitlab');assert.ok(!JSON.stringify(result).includes('fixture-token'));assert.ok(!('token_ciphertext' in result));assert.equal(saved[8],'gitlab');}finally{if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;}
});

test('GitLab and Gitea push verification rejects forged signatures, deleted branches and tags',()=>{
 const hooks=webhooks(),secret='fixture-hook-secret';
 for(const provider of ['gitlab','gitea']) {
  const payload={ref:'refs/heads/release/staging',after:'a'.repeat(40),project:{git_http_url:'https://git.local/team/app.git'},repository:{clone_url:'https://git.local/team/app.git'}};
  const raw=JSON.stringify(payload),headers=new Headers(provider==='gitlab'?{'x-gitlab-token':secret}:{'x-gitea-signature':createHmac('sha256',secret).update(raw).digest('hex')});
  assert.equal(hooks.verifyGitWebhook(provider,raw,headers,secret),true);
  assert.equal(hooks.verifyGitWebhook(provider,raw,headers,'wrong'),false);
  if(provider==='gitea')assert.equal(hooks.verifyGitWebhook(provider,raw+' ',headers,secret),false);
  assert.deepEqual(hooks.gitPush(provider,payload),{repository:'https://git.local/team/app',branch:'release/staging',sha:'a'.repeat(40)});
  assert.equal(hooks.gitPush(provider,{...payload,after:'0'.repeat(40)}),null);
  assert.equal(hooks.gitPush(provider,{...payload,ref:'refs/tags/v1'}),null);
 }
});

test('push receiver authorizes each application separately and skips the live commit',async()=>{
 const hooks=webhooks();const calls=[];const sha='a'.repeat(40);
 const handler=load('lib/git-webhook-handler.ts',{'@/lib/db':{query:async()=>({rows:[
  {id:'ok',name:'ok',repo_url:'https://git.local/team/app.git',webhook_secret:'correct'},
  {id:'wrong-secret',repo_url:'https://git.local/team/app.git',webhook_secret:'different'},
  {id:'wrong-host',repo_url:'https://other.local/team/app.git',webhook_secret:'correct'},
  {id:'live',repo_url:'https://git.local/team/app.git',webhook_secret:'correct',live_commit:sha},
 ]})},'@/lib/deploy':{startDeploy:async p=>{calls.push(p.id);return 'deployment';}},'./git-provider-policy':policy,'./git-webhooks':hooks});
 const raw=JSON.stringify({ref:'refs/heads/main',after:sha,project:{git_http_url:'https://git.local/team/app.git'}});
 const response=await handler.receiveGitPush(new Request('https://deploy/api/webhooks/gitlab',{method:'POST',headers:{'x-gitlab-event':'Push Hook','x-gitlab-token':'correct'},body:raw}),'gitlab');
 assert.equal(response.status,200);assert.deepEqual(calls,['ok']);
 const bad=await handler.receiveGitPush(new Request('https://deploy/api/webhooks/gitlab',{method:'POST',headers:{'x-gitlab-event':'Push Hook','x-gitlab-token':'forged'},body:raw}),'gitlab');
 assert.equal(bad.status,401);assert.deepEqual(calls,['ok']);
});

test('API adapter keeps provider endpoints distinct and rejects private keys as CA input',()=>{
 assert.equal(api.gitApiRoot(policy.gitHost('gitlab','https://git.local/code')),'https://git.local/code/api/v4');
 assert.equal(api.gitApiRoot(policy.gitHost('gitea','https://git.local:8443')),'https://git.local:8443/api/v1');
 assert.equal(api.gitApiRoot(policy.gitHost()),'https://api.github.com');
 assert.throws(()=>api.validateGitCa('-----BEGIN PRIVATE KEY-----x'));
 assert.throws(()=>api.validateGitCa('not a certificate'));
});

module.exports={policy,api,paths,connections};

test('self-hosted webhook registration uses provider APIs, TLS verification and a shared environment secret',async()=>{
 for(const provider of ['gitlab','gitea']) {
  const host={provider,base_url:'https://git.institution.test/code',account_login:'bot'};
  const project={id:'production',repo_url:host.base_url+'/team/app.git',github_connection_id:'connection',webhook_secret:null};
  const calls=[],writes=[];
  const hooks=webhooks(async(sql,params)=>{
   if(sql.startsWith('select id,repo_url,github_connection_id'))return {rows:[project]};
   if(sql.startsWith('select id,repo_url,webhook_secret'))return {rows:[project,{...project,id:'staging',webhook_secret:'environment-secret'},{...project,id:'other-host',repo_url:'https://other.test/team/app.git',webhook_secret:'must-not-reuse'}]};
   writes.push({sql,params});return {rows:[]};
  },{'./github-connections':{getGitConnection:async()=>host,getGitHubConnectionToken:async()=> 'token'},'./git-provider-api':{gitApi:async(_host,_token,resource,options={})=>{
   calls.push({resource,...options});return {ok:true,status:200,data:options.method?{id:42}:[]};
  }}});
  const result=await hooks.ensureGitWebhook('production');assert.deepEqual(result.projectIds,['production','staging']);
  const post=calls.find(call=>call.method==='POST');assert.ok(post);
  if(provider==='gitlab'){
   assert.equal(post.resource,'/projects/team%2Fapp/hooks');assert.equal(post.body.enable_ssl_verification,true);assert.equal(post.body.token,'environment-secret');assert.equal(post.body.push_events,true);
  }else{
   assert.equal(post.resource,'/repos/team/app/hooks');assert.equal(post.body.type,'gitea');assert.equal(post.body.config.secret,'environment-secret');assert.deepEqual(post.body.events,['push']);
  }
  assert.equal(post.body.url||post.body.config.url,`https://deploy.institution.test/api/webhooks/${provider}`);
  assert.deepEqual(writes[0].params,['environment-secret',['production','staging']]);
 }
});

test('GitLab/Gitea credentials never reach another host or repository and mismatch fails before token lookup',async()=>{
 const {execFileSync}=require('node:child_process');
 for(const provider of ['gitlab','gitea']){
  let reads=0;const host={provider,base_url:'https://git.local:8443/code',account_login:'bot'};
  const access=require('./git-access-fixture.cjs')(async()=>{reads++;return 'private-token';},host);
  await assert.rejects(()=>access.prepareGitAccess({repo_url:'https://other.local/code/team/app.git'}),/selected Git connection/);assert.equal(reads,0);
  const auth=await access.prepareGitAccess({repo_url:host.base_url+'/team/app.git'}),env={...process.env,...access.gitEnvironment(auth.config)};
  const match=url=>execFileSync(access.installedGit(process.cwd()),['config','--get-urlmatch','http.extraheader',url],{env,windowsHide:true,encoding:'utf8'}).trim();
  assert.equal(match(host.base_url+'/team/app.git/info/refs'),'Authorization: Basic '+Buffer.from('bot:private-token').toString('base64'));
  for(const url of [host.base_url+'/team/other.git',host.base_url+'/team/app-copy.git','https://other.local:8443/code/team/app.git','http://git.local:8443/code/team/app.git'])assert.equal(match(url),'');
 }
});
