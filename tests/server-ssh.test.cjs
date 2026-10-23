const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { Server, utils } = require('ssh2');
const load = require('./server-module.cjs');
const policy = require('../scripts/manager-agent.cjs');
class ApiError extends Error { constructor(message,status){super(message);this.status=status;} }
const ssh = load('lib/server-ssh.ts', {
  '@/lib/db': {}, '@/lib/api': {ApiError}, '@/lib/audit': {}, '@/lib/managed-servers': {}, '@/scripts/manager-agent.cjs': policy,
});

test('SSH target validation separates an address from commands and URLs', () => {
  assert.deepEqual(ssh.sshTarget({host:'[2001:db8::1]',username:'admin'}), {host:'2001:db8::1',port:22,username:'admin'});
  assert.equal(ssh.sshTarget({host:'host.example.edu',port:'2222',username:'DOMAIN\\admin'}).port,2222);
  for (const patch of [{host:'host;command'},{host:'https://host'},{host:'-oProxyCommand=bad'},{host:'host/path'},{port:0},{port:65536},{username:'admin\ncommand'}]) {
    assert.throws(()=>ssh.sshTarget({host:'10.0.0.1',username:'admin',...patch}));
  }
});

test('real SSH handshake pins identity before password auth; commands, errors and timeouts propagate', {timeout:15000}, async t => {
  const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const expected = ssh.fingerprint(utils.parseKey(privateKey).getPublicSSH());
  let passwordAttempts=0, receivedInput=''; const clients=new Set();
  const server = new Server({hostKeys:[privateKey]}, client => {
    clients.add(client); client.on('error',()=>{}).on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>{
      if(ctx.method==='password'){ passwordAttempts++; return ctx.password==='test-password' && ctx.username==='admin' ? ctx.accept() : ctx.reject(); }
      ctx.reject(['password']);
    }).on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
      const stream=accept();
      stream.on('data',chunk=>{ receivedInput+=chunk.toString(); });
      stream.on('end',()=>{
        if(info.command==='hang')return;
        if(info.command==='bad'){stream.stderr.write('prerequisite unavailable');stream.exit(7);}
        else {stream.write('agent-ready\n');stream.exit(0);}
        stream.end();
      });
    })));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ for(const client of clients)client.end(); await new Promise(resolve=>server.close(resolve)); });
  const target={host:'127.0.0.1',port:server.address().port,username:'admin'};
  assert.equal((await ssh.probeSsh(target)).fingerprint,expected);
  assert.equal(passwordAttempts,0,'Discovery must not authenticate');
  await assert.rejects(ssh.connectSsh(target,'test-password','SHA256:'+'A'.repeat(43)),/host key changed/);
  assert.equal(passwordAttempts,0,'Wrong identity must never receive the password');
  await assert.rejects(ssh.connectSsh(target,'wrong-password',expected),/SSH connection failed/);
  const connection=await ssh.connectSsh(target,'test-password',expected);
  t.after(()=>connection.destroy());
  let log='';
  assert.equal(await ssh.sshExec(connection,'ok','sudo-password\n',2000,text=>{log+=text;}),'agent-ready\n');
  assert.equal(receivedInput,'sudo-password\n');
  assert.equal(log,'agent-ready\n','stdin credentials are not output logs');
  await assert.rejects(ssh.sshExec(connection,'bad'),/Remote command failed \(7\).*prerequisite unavailable/);
  await assert.rejects(ssh.sshExec(connection,'hang','',50),/time limit/);
  connection.destroy();
});

test('installer metadata pins versions and rejects missing hashes or foreign release URLs', async t=>{
  const original=global.fetch; t.after(()=>{global.fetch=original;});
  let invalid=false; const hash='a'.repeat(64);
  global.fetch=async url=>{
    assert.ok(url.startsWith('https://'));
    if(url.endsWith('SHASUMS256.txt'))return new Response(`${hash}  node-v24.10.0-linux-x64.tar.xz\n${hash}  node-v24.10.0-linux-arm64.tar.xz\n${hash}  node-v24.10.0-win-x64.zip\n`);
    if(url.includes('registry.npmjs.org'))return Response.json({version:'6.0.0'});
    const git=url.includes('git-for-windows');
    const repository=git?'git-for-windows/git':'caddyserver/caddy';
    const names=git?['MinGit-2.50.0-64-bit.zip']:['caddy_2.10.0_linux_amd64.tar.gz','caddy_2.10.0_linux_arm64.tar.gz','caddy_2.10.0_windows_amd64.zip'];
    return Response.json({assets:names.map(name=>({name,digest:invalid==='hash'?undefined:`sha256:${hash}`,browser_download_url:`https://${invalid==='url'?'evil.example/':'github.com/'}${repository}/releases/download/v1/${name}`}))});
  };
  const linux=await ssh.installerDownloads('linux','arm64');
  assert.equal(linux.node.url,'https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-arm64.tar.xz');
  assert.ok(linux.caddy.url.endsWith('linux_arm64.tar.gz'));
  assert.equal(linux.node.sha256,hash); assert.equal(linux.git,undefined);
  const windows=await ssh.installerDownloads('win32','x64');assert.ok(windows.git.url.endsWith('MinGit-2.50.0-64-bit.zip'));
  for(const value of ['url','hash']){ invalid=value; await assert.rejects(ssh.installerDownloads('linux','x64'),/verified SHA-256/); }
  await assert.rejects(ssh.installerDownloads('win32','arm64'),/supports/);
});

test('SSH API requires administrator role, same origin and bounded JSON before opening a connection', async()=>{
  let role='viewer', calls=0;
  const bodyTools=load('lib/request-body.ts',{'@/lib/api':{ApiError}});
  const rbac=load('lib/rbac.ts',{'./api':{ApiError}});
  const route=load('app/api/servers/[id]/ssh/route.ts',{
    '@/lib/auth':{getSessionFromCookie:async()=>role?{id:'operator',role}:null}, '@/lib/rbac':rbac,
    '@/lib/api':{ApiError,jsonError:error=>Response.json({error:error.message},{status:error.status||500})},
    '@/lib/request-body':bodyTools, '@/lib/managed-servers':{uuid:value=>value},
    '@/lib/update-maintenance':{updateProtected:(_name,work)=>work()},
    '@/lib/server-ssh':{sshTarget:body=>body,probeSsh:async()=>{calls++;return{fingerprint:'test'};},setupServerSsh:async()=>{calls++;return{};}},
  });
  const context={params:Promise.resolve({id:'11111111-1111-4111-8111-111111111111'})};
  const request=(body={action:'probe'},headers={})=>new Request('https://manager/api/servers/id/ssh',{method:'POST',headers:{host:'manager',origin:'https://manager','content-type':'application/json',...headers},body:JSON.stringify(body)});
  for(const value of [null,'viewer','operator']){role=value;assert.equal((await route.POST(request(),context)).status,value?403:401);}
  role='admin';assert.equal((await route.POST(request({}, {origin:'https://attacker.example'}),context)).status,403);
  assert.equal((await route.POST(request({action:'setup',password:'x'.repeat(20000)}),context)).status,413);
  assert.equal(calls,0);
  assert.equal((await route.POST(request(),context)).status,200);assert.equal(calls,1);
});
