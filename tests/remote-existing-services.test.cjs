const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const agent=require('../scripts/manager-agent.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});

test('Windows PM2 uses independent pipes without modifying the reused installation',{skip:process.platform!=='win32',timeout:60000},async t=>{
  const pm2=path.join(process.env.APPDATA,'npm/node_modules/pm2/bin/pm2');
  try{await fs.access(pm2)}catch{t.skip('PM2 is unavailable');return}
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'agent-private-pm2-'));
  const roots=[path.join(parent,'first account'),path.join(parent,'second account')];
  const started=[];
  t.after(async()=>{for(const {root,env} of started){if(await fs.stat(path.join(root,'pm2/pm2.pid')).catch(()=>null))await agent.run(process.execPath,[pm2,'kill'],{env,timeout:15000})}await fs.rm(parent,{recursive:true,force:true})});
  const source=path.join(path.dirname(path.dirname(pm2)),'paths.js');const before=await fs.readFile(source,'utf8');
  const envs=[];
  for(const root of roots){
    await fs.mkdir(root);const env=await agent.privatePm2Environment(root,pm2);
    const resolved=await agent.run(process.execPath,['-e',`process.stdout.write(require(${JSON.stringify(source)})(process.env.PM2_HOME).DAEMON_RPC_PORT)`],{env});
    const marker=JSON.parse(await fs.readFile(path.join(root,'pm2-private-pipes.json'),'utf8'));
    assert.equal(resolved,marker.prefix+'-rpc.sock');assert.notEqual(resolved,'\\\\.\\pipe\\rpc.sock');
    started.push({root,env});envs.push(env);
  }
  const script=path.join(parent,'fixture.cjs');await fs.writeFile(script,'setInterval(()=>{},1000)');
  await agent.run(process.execPath,[pm2,'start',script,'--name','isolated-fixture','--interpreter',process.execPath],{env:envs[0]});
  const first=await agent.run(process.execPath,[pm2,'jlist'],{env:envs[0]});assert.match(first,/isolated-fixture/);
  const second=await agent.run(process.execPath,[pm2,'jlist'],{env:envs[1]});assert.doesNotMatch(second,/isolated-fixture/);assert.match(second,/\[\]\s*$/);
  assert.notEqual(await fs.readFile(path.join(roots[0],'pm2/pm2.pid'),'utf8'),await fs.readFile(path.join(roots[1],'pm2/pm2.pid'),'utf8'));
  assert.equal(await fs.readFile(source,'utf8'),before);
});

test('shared Caddy preserves an existing site, rejects ownership conflicts and survives reloads',{timeout:60000},async t=>{
  const caddy=process.env.TEST_CADDY||(process.platform==='win32'?'C:\\web\\caddy.exe':'/usr/bin/caddy');
  try{await fs.access(caddy)}catch{t.skip('Caddy is unavailable');return}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-shared-caddy-'));
  const adminPort=await freePort(),oldPort=await freePort(),newPort=await freePort();
  const admin='http://127.0.0.1:'+adminPort;
  await fs.mkdir(path.join(root,'managed-sites'));
  await fs.mkdir(path.join(root,'legacy'));
  await fs.writeFile(path.join(root,'legacy','routes.caddy'),`http://127.0.0.1:${oldPort} {\n respond "existing-site" 200\n}\n`);
  const source=`{\n admin 127.0.0.1:${adminPort} {\n origins ${admin}\n enforce_origin\n }\n auto_https off\n}\nimport routes.caddy\nimport ${JSON.stringify(path.join(root,'managed-sites','*.caddy').replace(/\\/g,'/'))}\n`;
  const configPath=path.join(root,'legacy','existing.Caddyfile');await fs.writeFile(configPath,source);
  const candidatePath=path.join(root,'legacy','manager-candidate');await fs.writeFile(candidatePath,'');
  const settings={mode:'existing-caddy',configPath,candidatePath,admin,sourceHash:createHash('sha256').update(source).digest('hex'),reservedHosts:['existing.example.test'],reservedPorts:[oldPort]};
  await fs.writeFile(path.join(root,'proxy.json'),JSON.stringify(settings));
  const child=spawn(caddy,['run','--config',configPath],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')}});let errors='';child.stderr.on('data',b=>errors=(errors+b).slice(-3000));
  t.after(async()=>{if(child.exitCode===null){await fetch(admin+'/stop',{method:'POST',headers:{Origin:admin}}).catch(()=>child.kill());await new Promise(r=>{if(child.exitCode!==null)return r();child.once('close',r)})}await fs.rm(root,{recursive:true,force:true})});
  let ready=false;for(let i=0;i<50;i++){if((await fetch(admin+'/config/',{headers:{Origin:admin}}).catch(()=>null))?.ok){ready=true;break}await sleep(100)}assert.ok(ready,errors);
  const tools={caddy,tools:{caddy:'test'},pm:()=>{throw Error('Shared Caddy must never start another PM2 proxy')}};
  const managed=`{\n}\n\nhttp://127.0.0.1:${newPort} {\n respond "managed-site" 200\n}\n`;
  const initialConfig=await (await fetch(admin+'/config/',{headers:{Origin:admin}})).json();
  await agent.proxyConfig(root,managed,tools);
  assert.equal(await (await fetch('http://127.0.0.1:'+oldPort)).text(),'existing-site');
  assert.equal(await (await fetch('http://127.0.0.1:'+newPort)).text(),'managed-site');
  assert.equal(await fs.readFile(configPath,'utf8'),source);
  assert.equal(await fs.readFile(path.join(root,'managed-sites/active.caddy'),'utf8'),managed.slice(managed.indexOf('\n}\n\n')+4));
  const activeConfig=await (await fetch(admin+'/config/',{headers:{Origin:admin}})).json();
  await fs.writeFile(path.join(root,'shared-proxy-transaction.json'),JSON.stringify({previousHash:agent.configDigest(initialConfig),nextHash:agent.configDigest(activeConfig),sites:managed.slice(managed.indexOf('\n}\n\n')+4)}));
  await fs.writeFile(path.join(root,'managed-sites/active.caddy'),'');
  await agent.proxyConfig(root,managed,tools);
  assert.equal(await fs.stat(path.join(root,'shared-proxy-transaction.json')).catch(()=>null),null,'interrupted file persistence recovered from the accepted Caddy config');
  await assert.rejects(agent.proxyConfig(root,'{\n}\n\nhttps://existing.example.test {\n respond "blocked"\n}\n',tools),/belongs to an existing site/);
  await agent.proxyConfig(root,'{\n}\n\n',tools);assert.equal(await (await fetch('http://127.0.0.1:'+oldPort)).text(),'existing-site');
  await fs.appendFile(configPath,'# outside change\n');await assert.rejects(agent.proxyConfig(root,managed,tools),/configuration changed/);
  await fs.writeFile(configPath,source);
  const current=await fetch(admin+'/config/',{headers:{Origin:admin}}),changed=await current.json();
  const edit=value=>{if(!value||typeof value!=='object')return;if(value.handler==='static_response')value.body='external-change';for(const child of Object.values(value))edit(child)};edit(changed);
  const update=await fetch(admin+'/config/',{method:'POST',headers:{Origin:admin,'Content-Type':'application/json','If-Match':current.headers.get('etag')},body:JSON.stringify(changed)});assert.equal(update.status,200);
  await assert.rejects(agent.proxyConfig(root,managed,tools),/differs from its files/);
});
