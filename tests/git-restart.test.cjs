const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const https=require('node:https'),cp=require('node:child_process');
const load=require('./server-module.cjs');
const policy=require('../lib/git-provider-policy.ts'),api=require('../lib/git-provider-api.ts');
const openssl=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:\\Program Files','Git','usr','bin','openssl.exe'):'openssl';
const run=(file,args,options={})=>new Promise((resolve,reject)=>{cp.execFile(file,args,{windowsHide:true,timeout:45000,...options},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message))):resolve(String(stdout)));});

test('HTTPS GitLab/Gitea clone, fetch and promotion push survive fresh processes and empty user profiles', {timeout:120000}, async t=>{
 const temp=await fsp.realpath(os.tmpdir()),root=await fsp.mkdtemp(path.join(temp,'synergy-git-restart-'));
 t.after(async()=>{assert.equal(path.dirname(root),temp);assert.equal(await fsp.realpath(root),root);await fsp.rm(root,{recursive:true,force:true});});
 const certFile=path.join(root,'ca.pem'),keyFile=path.join(root,'fixture.key');
 await run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',certFile,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE']);
 const ca=await fsp.readFile(certFile,'utf8'),token='fixture-private-repo-token-123',username='institution-bot';
 const git=cp.execFileSync(process.platform==='win32'?'where.exe':'which',['git'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
 const gitExec=cp.execFileSync(git,['--exec-path'],{encoding:'utf8',windowsHide:true}).trim();
 const backend=path.join(gitExec,process.platform==='win32'?'git-http-backend.exe':'git-http-backend');
 const repositories=path.join(root,'repositories'),seed=path.join(root,'seed');await fsp.mkdir(seed,{recursive:true});
 await run(git,['init','-b','main'],{cwd:seed});await run(git,['config','user.name','Fixture'],{cwd:seed});await run(git,['config','user.email','fixture@example.test'],{cwd:seed});
 await fsp.writeFile(path.join(seed,'version.txt'),'one');await run(git,['add','.'],{cwd:seed});await run(git,['commit','-m','initial'],{cwd:seed});
 for(const provider of ['gitlab','gitea']){
  const bare=path.join(repositories,provider,'team','app.git');await fsp.mkdir(path.dirname(bare),{recursive:true});await run(git,['clone','--bare',seed,bare]);await run(git,['-C',bare,'config','http.receivepack','true']);
 }
 const apiCalls=[];let origin;
 const server=https.createServer({key:fs.readFileSync(keyFile),cert:ca},async(req,res)=>{
  try{
   const url=new URL(req.url,origin);const provider=url.pathname.split('/')[1];
   if(url.pathname.includes('/api/')){
    apiCalls.push({url:url.pathname,token:req.headers['private-token']||req.headers.authorization});
    if((provider==='gitlab'?req.headers['private-token']:req.headers.authorization)!==(provider==='gitlab'?token:`token ${token}`)){res.writeHead(401);res.end('{}');return;}
    if(url.pathname.endsWith('/user')){res.setHeader('content-type','application/json');res.end(JSON.stringify(provider==='gitlab'?{username}:{login:username}));return;}
    if(url.pathname.endsWith('/redirect')){res.writeHead(302,{location:origin+'/must-not-follow'});res.end('{}');return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify([{id:1,name:'app',path_with_namespace:provider==='gitlab'?'team/app':undefined,full_name:'team/app',http_url_to_repo:provider==='gitlab'?origin+'/gitlab/team/app.git':undefined,clone_url:origin+'/gitea/team/app.git',default_branch:'main',visibility:'private',private:true}]));return;
   }
   if(req.headers.authorization!=='Basic '+Buffer.from(username+':'+token).toString('base64')){res.writeHead(401,{'www-authenticate':'Basic realm="fixture"'});res.end();return;}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
   const child=cp.spawn(backend,[],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:repositories,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:String(body.length),REMOTE_USER:username,REMOTE_ADDR:'127.0.0.1',HTTP_GIT_PROTOCOL:req.headers['git-protocol']||''}});
   const output=[];child.stdout.on('data',chunk=>output.push(chunk));child.stderr.resume();
   child.on('error',()=>{res.writeHead(500);res.end();});
   child.on('close',()=>{const bytes=Buffer.concat(output),end=bytes.indexOf('\r\n\r\n');if(end<0){res.writeHead(500);res.end();return;}for(const line of bytes.subarray(0,end).toString().split('\r\n')){const at=line.indexOf(':');if(at<0)continue;const key=line.slice(0,at),value=line.slice(at+1).trim();if(key.toLowerCase()==='status')res.statusCode=Number(value.split(' ')[0]);else res.setHeader(key,value);}res.end(bytes.subarray(end+4));});child.stdin.end(body);
  }catch{res.writeHead(500);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const previous=process.env.JWT_SECRET,override=process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY;process.env.JWT_SECRET='persisted-fixture-key';delete process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY;
 const conn=load('lib/github-connections.ts',{'@/lib/api':{ApiError:Error},'@/lib/db':{},'@/lib/settings':{},'./git-provider-policy':policy,'./git-provider-api':api});
 const ciphertext=conn.encryptToken(token);
 if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;if(override!==undefined)process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY=override;
 for(const provider of ['gitlab','gitea']){
  const host={provider,base_url:origin+'/'+provider,ca_pem:ca,account_login:username};
  await assert.rejects(()=>api.inspectGitToken({...host,ca_pem:null},token),/securely/);
  assert.equal((await api.inspectGitToken(host,token)).account.login,username);
  assert.equal((await api.listGitRepositories(host,token,1))[0].fullName,'team/app');
  assert.equal((await api.gitApi(host,token,'/redirect')).status,302);
  const checkout=path.join(root,provider+'-checkout'),file=path.join(root,provider+'.json');
  const fixture={host,repo:host.base_url+'/team/app.git',ciphertext,checkout,stateRoot:path.join(root,'machine-state'),operation:'clone'};
  await fsp.writeFile(file,JSON.stringify(fixture));
  for(const operation of ['clone','fetch']){
   const profile=path.join(root,provider+'-'+operation+'-empty-profile');await fsp.mkdir(profile);
   const env={Path:process.env.Path||process.env.PATH,PATH:process.env.PATH||process.env.Path,SystemRoot:process.env.SystemRoot,ProgramFiles:process.env.ProgramFiles,TEMP:root,TMP:root,USERPROFILE:profile,HOME:profile,NODE_PATH:process.env.NODE_PATH,JWT_SECRET:'persisted-fixture-key'};
   if(operation==='fetch'){
    await fsp.writeFile(path.join(seed,'version.txt'),provider+' two');await run(git,['add','.'],{cwd:seed});await run(git,['commit','-m','update'],{cwd:seed});await run(git,['push',path.join(repositories,provider,'team','app.git'),'main'],{cwd:seed});
    fixture.operation='fetch';fixture.push=true;await fsp.writeFile(file,JSON.stringify(fixture));
   }
   const output=await run(process.execPath,['--require',path.resolve('tests/register.cjs'),path.resolve('tests/fixtures/git-restart-client.cjs'),file],{cwd:process.cwd(),env});
   assert.match(output,/fresh profile/);assert.ok(!output.includes(token));
  }
  assert.equal(fs.readFileSync(path.join(checkout,'version.txt'),'utf8'),provider+' two');
  assert.equal(cp.execFileSync(git,['-C',checkout,'remote','get-url','origin'],{encoding:'utf8',windowsHide:true}).trim(),fixture.repo);
  assert.ok(!fs.readFileSync(path.join(checkout,'.git','config'),'utf8').includes(token));
  assert.equal(cp.execFileSync(git,['--git-dir',path.join(repositories,provider,'team','app.git'),'show','main:after-reboot.txt'],{encoding:'utf8',windowsHide:true}),'created after restart');
 }
 assert.ok(apiCalls.some(call=>call.url.includes('/api/v4/')));assert.ok(apiCalls.some(call=>call.url.includes('/api/v1/')));assert.ok(!apiCalls.some(call=>call.url.includes('must-not-follow')));
});
