const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const load=require('./server-module.cjs');
const agent=require('../scripts/manager-agent.cjs');
const catalog=load('lib/server-tool-catalog.ts',{});
const policy=load('lib/server-discovery.ts',{'./server-tool-catalog':catalog});
class ApiError extends Error {constructor(message,status){super(message);this.status=status}}
const mocks={'@/lib/db':{},'@/lib/api':{ApiError},'@/lib/audit':{},'@/lib/managed-servers':{},'@/scripts/agent-bundle.cjs':require('../scripts/agent-bundle.cjs'),'@/scripts/manager-agent.cjs':agent,'@/lib/server-tool-catalog':catalog,'@/lib/server-discovery':policy};

test('custom database client is the executable used for database queries, and survives config reload',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-tools-test-'));
  const envKey=Object.keys(process.env).find(k=>k.toLowerCase()==='path');const original=process.env[envKey];
  t.after(async()=>{await fs.writeFile(path.join(root,'tool-paths.json'),'{}');await agent.loadToolPaths(root);process.env[envKey]=original;await fs.rm(root,{recursive:true,force:true})});
  await fs.writeFile(path.join(root,'tool-paths.json'),JSON.stringify({psql:process.execPath}));
  await agent.loadToolPaths(root);
  const calls=[];
  const job={id:'11111111-1111-4111-8111-111111111111',payload:{id:'22222222-2222-4222-8222-222222222222',database:{mode:'existing',provider:'postgresql',host:'127.0.0.1',port:5544,database:'existing_database',username:'application',password:'test-only-secret'}}};
  await agent.setupDatabase(root,job,()=>{},{run:async(file,args,options)=>{calls.push({file,args,options});return '1\n'}});
  assert.equal(calls.length,1);assert.equal(calls[0].file,process.execPath);assert.equal(calls[0].args[calls[0].args.indexOf('--port')+1],'5544');
  assert.ok(!JSON.stringify(calls[0].args).includes('test-only-secret'));
  assert.doesNotMatch(calls[0].options.input,/CREATE|ALTER|DROP/);
  await agent.loadToolPaths(root);assert.equal((await agent.setupDatabase(root,job,()=>{},{run:async file=>{assert.equal(file,process.execPath);return '1'}})).ok,true);
  await fs.writeFile(path.join(root,'tool-paths.json'),JSON.stringify({psql:path.join(root,'missing-client')}));
  await assert.rejects(agent.loadToolPaths(root),/ENOENT/);
});

test('read-only Windows discovery executes with custom paths and reports actual service inventory', {skip:process.platform!=='win32',timeout:120000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'manager-inspect-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'inspect.ps1');
  const custom={node:process.execPath,psql:path.join(dir,"custom ' database",'psql.exe')};
  const source=(await fs.readFile(path.join(__dirname,'../scripts/inspect-remote-server.ps1'),'utf8')).replace('__MANAGER_PATHS__',JSON.stringify(custom).replace(/'/g,"''"));
  await fs.writeFile(file,source);
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{windowsHide:true,timeout:110000,maxBuffer:200000});
  const ssh=load('lib/server-ssh.ts',mocks);const inventory=ssh.parseServerInventory(stdout,'win32');
  assert.equal(inventory.platform,'win32');assert.ok(inventory.tools.node.some(tool=>tool.path===process.execPath && tool.compatible));
  assert.ok(inventory.tools.psql.some(tool=>tool.path===custom.psql && !tool.compatible));
  assert.ok(Array.isArray(inventory.services));
});

test('fresh SSH inspection blocks occupied Caddy ports before downloads or enrollment',{timeout:15000},async t=>{
  const {Server,utils}=require('ssh2');const {generateKeyPairSync}=require('node:crypto');
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const clients=new Set();const inputs=[];let enrollments=0,downloads=0;
  const line=(kind,...values)=>[kind,...values.map(v=>Buffer.from(v).toString('base64'))].join('\t');
  const output=[line('meta','Linux','x64','0'),line('ports','known'),line('port','443')].join('\n');
  const server=new Server({hostKeys:[privateKey]},client=>{clients.add(client);client.on('error',()=>{}).on('close',()=>clients.delete(client));client.on('authentication',ctx=>ctx.method==='password'?ctx.accept():ctx.reject(['password'])).on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
    const stream=accept();let input='';stream.on('data',data=>input+=data);stream.on('end',()=>{inputs.push({command:info.command,input});stream.write(info.command==='/bin/bash -s'?output:'MANAGER_OS=Linux\nMANAGER_ARCH=x86_64\nMANAGER_UID=0\n');stream.exit(0);stream.end()});
  })))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const c of clients)c.end();await new Promise(resolve=>server.close(resolve))});
  const fetch=global.fetch;global.fetch=async()=>{downloads++;throw Error('No downloads expected')};t.after(()=>global.fetch=fetch);
  const row={platform:'linux',enabled:true,enrolled_at:null};const lease={query:async sql=>({rows:[sql.includes('try_advisory')?{acquired:true}:row]}),release(){}};
  const ssh=load('lib/server-ssh.ts',{...mocks,'@/lib/db':{db:{query:async()=>({rows:[row]}),connect:async()=>lease}},'@/lib/audit':{audit:async()=>{}},'@/lib/managed-servers':{ensureManagedServers:async()=>{},uuid:v=>v,changeServer:async()=>{enrollments++;throw Error('No enrollment expected')}}});
  const body={host:'127.0.0.1',port:server.address().port,username:'root',password:'fixture-password',fingerprint:ssh.fingerprint(utils.parseKey(privateKey).getPublicSSH()),acceptFingerprint:true,manager:'https://manager.example.edu',reviewed:true,tools:Object.fromEntries(catalog.SERVER_TOOLS.map(tool=>[tool.id,{mode:tool.required?'install':'skip',path:''}]))};
  const inspected=await ssh.inspectServerSsh('11111111-1111-4111-8111-111111111111',{...body,paths:{psql:"/opt/Database's Tools/psql"}},'admin');
  assert.deepEqual(inspected.inventory.ports,[443]);assert.match(inputs[0].input,/TOOL_psql=/);assert.ok(!inputs[0].input.includes(body.password));
  await assert.rejects(ssh.setupServerSsh('11111111-1111-4111-8111-111111111111',body,'admin'),/Ports 443 are already in use/);
  assert.equal(enrollments,0);assert.equal(downloads,0);assert.ok(!inputs.some(item=>/bootstrap-remote-agent/.test(item.command)));
});

test('Linux discovery preserves quoted custom paths and reports services and ports',{timeout:60000},async t=>{
  const bash=process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'/bin/bash';
  try {await fs.access(bash)} catch {t.skip('Bash is unavailable');return}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'manager-linux-inspect-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const posix=p=>process.platform==='win32'?p.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>'/'+d.toLowerCase()):p;
  const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
  const bin=path.join(dir,'bin');await fs.mkdir(bin);
  for(const [name,body] of Object.entries({uname:'[ "$1" = -m ] && echo x86_64 || echo Linux',id:'echo 0',ss:'echo "LISTEN 0 100 127.0.0.1:5432 0.0.0.0:*"',systemctl:'[ "$1" = is-active ] && echo active || echo "postgresql.service enabled"'}))await fs.writeFile(path.join(bin,name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  const client=path.join(dir,"Database's $& Tools",'psql');await fs.mkdir(path.dirname(client));await fs.writeFile(client,'#!/bin/bash\nprintf "psql (PostgreSQL) 18.1\\n"\n',{mode:0o755});
  const source=(await fs.readFile(path.join(__dirname,'../scripts/inspect-remote-server.sh'),'utf8')).replace(/\r\n/g,'\n').replace('__MANAGER_PATHS__',()=>`export PATH=${quote(posix(bin))}:/usr/bin:/bin\nTOOL_psql=${quote(posix(client))}`);
  const file=path.join(dir,'inspect.sh');await fs.writeFile(file,source);
  const {stdout}=await promisify(execFile)(bash,[posix(file)],{windowsHide:true,timeout:55000,maxBuffer:200000});
  const inventory=load('lib/server-ssh.ts',mocks).parseServerInventory(stdout,'linux');
  assert.deepEqual(inventory.ports,[5432]);assert.equal(inventory.portsKnown,true);
  assert.ok(inventory.tools.psql.some(tool=>tool.path===posix(client)&&tool.compatible));
  assert.ok(inventory.services.some(service=>service.name==='postgresql.service'&&service.status==='active'));
});
