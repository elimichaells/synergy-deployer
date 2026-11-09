const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { Server, utils } = require('ssh2');
const load = require('./server-module.cjs');
const policy = require('../scripts/manager-agent.cjs');
const catalog = load('lib/server-tool-catalog.ts',{});
const discovery = load('lib/server-discovery.ts',{'./server-tool-catalog':catalog});
class ApiError extends Error { constructor(message,status){super(message);this.status=status;} }
const ssh = load('lib/server-ssh.ts', {
  '@/lib/db': {}, '@/lib/api': {ApiError}, '@/lib/audit': {}, '@/lib/managed-servers': {}, '@/scripts/agent-bundle.cjs':require('../scripts/agent-bundle.cjs'),'@/scripts/manager-agent.cjs': policy,
  '@/lib/server-discovery':discovery, '@/lib/server-tool-catalog':catalog,
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

test('private-key authentication pins the host, verifies signatures and never attempts passwords',{timeout:15000},async t=>{
  const pair=()=>generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const host=pair(),clientKey=pair(),parsed=utils.parseKey(clientKey.privateKey);
  const expected=ssh.fingerprint(utils.parseKey(host.privateKey).getPublicSSH());
  let attempts=0,passwords=0;const clients=new Set();
  const server=new Server({hostKeys:[host.privateKey]},client=>{
    clients.add(client);client.on('error',()=>{}).on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>{
      if(ctx.method==='password'){passwords++;ctx.reject(['publickey']);return}
      if(ctx.method!=='publickey'){ctx.reject(['publickey']);return}
      attempts++;
      if(ctx.username==='admin'&&ctx.key.data.equals(parsed.getPublicSSH())&&(!ctx.signature||parsed.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))ctx.accept();else ctx.reject(['publickey']);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const c of clients)c.end();await new Promise(resolve=>server.close(resolve))});
  const target={host:'127.0.0.1',port:server.address().port,username:'admin'};
  const auth=ssh.sshCredentials({authentication:'key',privateKey:clientKey.privateKey,password:'must-not-be-used'});
  assert.equal(auth.password,undefined);assert.equal((await ssh.probeSsh(target)).fingerprint,expected);assert.equal(attempts,0);
  await assert.rejects(ssh.connectSsh(target,auth,'SHA256:'+'A'.repeat(43)),/host key changed/);assert.equal(attempts,0);
  const connection=await ssh.connectSsh(target,auth,expected);connection.end();assert.ok(attempts>=1);assert.equal(passwords,0);
  const encrypted=require('node:crypto').createPrivateKey(clientKey.privateKey).export({type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'fixture-key-passphrase'});
  assert.throws(()=>ssh.sshCredentials({authentication:'key',privateKey:encrypted,passphrase:'wrong'}),/format and passphrase/);
  const encryptedConnection=await ssh.connectSsh(target,ssh.sshCredentials({authentication:'key',privateKey:encrypted,passphrase:'fixture-key-passphrase'}),expected);encryptedConnection.end();
  for(const body of [{authentication:'unexpected'},{authentication:'key',privateKey:'bad'},{authentication:'key',privateKey:'x'.repeat(16385)},{authentication:'key',privateKey:clientKey.privateKey,sudoPassword:'bad\npassword'},{authentication:'key',privateKey:clientKey.publicKey}])assert.throws(()=>ssh.sshCredentials(body));
  assert.deepEqual(ssh.sudoCommand(auth),{prefix:'sudo -n -- ',input:''});
  assert.deepEqual(ssh.sudoCommand({...auth,sudoPassword:'sudo-only'}),{prefix:"sudo -S -p '' -- ",input:'sudo-only\n'});
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
    '@/lib/server-ssh':{sshTarget:body=>body,probeSsh:async()=>{calls++;return{fingerprint:'test'};},inspectServerSsh:async()=>{calls++;return{inventory:{}};},setupServerSsh:async()=>{calls++;return{};}},
  });
  const context={params:Promise.resolve({id:'11111111-1111-4111-8111-111111111111'})};
  const request=(body={action:'probe'},headers={})=>new Request('https://manager/api/servers/id/ssh',{method:'POST',headers:{host:'manager',origin:'https://manager','content-type':'application/json',...headers},body:JSON.stringify(body)});
  for(const value of [null,'viewer','operator']){role=value;for(const action of ['probe','inspect','setup'])assert.equal((await route.POST(request({action}),context)).status,value?403:401);}
  role='admin';assert.equal((await route.POST(request({}, {origin:'https://attacker.example'}),context)).status,403);
  assert.equal((await route.POST(request({action:'setup',password:'x'.repeat(65536)}),context)).status,413);
  assert.equal(calls,0);
  assert.equal((await route.POST(request(),context)).status,200);assert.equal(calls,1);
  assert.equal((await route.POST(request({action:'inspect'}),context)).status,200);assert.equal(calls,2);
});

test('all reused prerequisites require no release network access; only missing tools download metadata',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);const calls=[];
  global.fetch=async url=>{calls.push(url);if(url==='https://registry.npmjs.org/pm2/latest')return Response.json({version:'6.0.0'});throw Error('Unexpected release download');};
  assert.deepEqual(await ssh.installerDownloads('win32','x64',[]),{});
  assert.equal(calls.length,0);
  assert.deepEqual(await ssh.installerDownloads('linux','x64',['pm2']),{pm2Version:'6.0.0'});
  assert.deepEqual(calls,['https://registry.npmjs.org/pm2/latest']);
});

test('custom paths are OS-specific executable paths, never shell command text',()=>{
  assert.equal(discovery.toolPath('D:\\Database Tools\\pgsql\\psql.exe','win32','psql'),'D:\\Database Tools\\pgsql\\psql.exe');
  assert.equal(discovery.toolPath('/opt/My Database/bin/psql','linux','psql'),'/opt/My Database/bin/psql');
  for(const p of ['psql','C:relative.exe','\\\\server\\share\\psql.exe','C:\\psql.exe;C:\\bad','C:\\psql.exe --password','C:\\psql.exe:stream'])assert.throws(()=>discovery.toolPath(p,'win32','psql'));
  for(const p of ['bin/psql','/opt/bin:other/psql','/bin/psql\ncommand'])assert.throws(()=>discovery.toolPath(p,'linux','psql'));
  assert.throws(()=>discovery.discoveryPaths({unknown:'/bin/x'},'linux'));
  assert.equal(discovery.toolCompatible('node','v18.0.0'),false);
  assert.equal(discovery.toolCompatible('node','v24.10.0'),true);
  assert.equal(discovery.toolCompatible('psql','psql (PostgreSQL) 18.1'),true);
  assert.equal(discovery.toolCompatible('psql','unrelated 18.1'),false);
});

test('fresh inventory blocks conflicts and invalid reuse instead of silently installing or adopting',()=>{
  const selections=Object.fromEntries(catalog.SERVER_TOOLS.map(t=>[t.id,{mode:t.required?'install':'skip',path:''}]));
  selections.psql={mode:'reuse',path:'/custom/postgres/psql'};
  const plan=discovery.selectedTools(selections,'linux');
  const tools=Object.fromEntries(catalog.SERVER_TOOLS.map(t=>[t.id,[]]));tools.psql=[{path:'/custom/postgres/psql',compatible:true,version:'psql (PostgreSQL) 18.1'}];
  const inventory={platform:'linux',arch:'x64',portsKnown:true,ports:[5432,3306],tools,services:[],privileged:true};
  discovery.verifyToolPlan(plan,inventory);
  assert.throws(()=>discovery.verifyToolPlan(plan,{...inventory,ports:[443,5432]}),/already in use/);
  assert.throws(()=>discovery.verifyToolPlan(plan,{...inventory,portsKnown:false}),/Could not inspect/);
  assert.throws(()=>discovery.verifyToolPlan(plan,{...inventory,tools:{...tools,psql:[]}}),/missing, incompatible or inaccessible/);
  assert.throws(()=>discovery.selectedTools({...selections,psql:{mode:'install'}},'linux'),/Choose how/);
  assert.throws(()=>discovery.selectedTools({...selections,caddy:{mode:'skip'}},'linux'),/Choose how/);
});

test('Windows and Linux inventories preserve exact paths and distinguish clients from running services',()=>{
  const win=ssh.parseServerInventory('MANAGER_INVENTORY='+JSON.stringify({platform:'win32',arch:'x64',privileged:true,portsKnown:true,ports:[5432,5432],services:[{name:'postgresql-x64-18',status:'Running',executable:'D:\\PG\\bin\\pg_ctl.exe',config:'E:\\Data'}],tools:{psql:[{path:'D:\\PG\\bin\\psql.exe',version:'psql (PostgreSQL) 18.1'}]}}),'win32');
  assert.equal(win.tools.psql[0].compatible,true);assert.equal(win.services[0].config,'E:\\Data');assert.deepEqual(win.ports,[5432]);
  const line=(kind,...v)=>[kind,...v.map(s=>Buffer.from(s).toString('base64'))].join('\t');
  const linux=ssh.parseServerInventory([line('meta','Linux','arm64','1000'),line('ports','known'),line('tool','psql',"/opt/Database's Tools/psql",'psql (PostgreSQL) 18.1',''),line('service','postgresql.service','active','',''),line('port','5432')].join('\n'),'linux');
  assert.equal(linux.tools.psql[0].path,"/opt/Database's Tools/psql");assert.equal(linux.privileged,false);assert.equal(linux.services[0].name,'postgresql.service');
  assert.throws(()=>ssh.parseServerInventory(line('meta','Darwin','arm64','0'),'linux'),/unsupported operating system/);
});
