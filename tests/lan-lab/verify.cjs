'use strict';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.MANAGER_LAN_LAB!=='1'||process.platform!=='win32')throw Error('LAN acceptance lab requires a disposable hosted Windows VM');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),https=require('node:https'),net=require('node:net'),cp=require('node:child_process'),{promisify}=require('node:util'),assert=require('node:assert/strict');
const exec=promisify(cp.exec),root='C:/ManagerLanLab',binary=root+'/bin/caddy.exe',load=require('../server-module.cjs'),lan=require('../../scripts/lan-address.cjs'),agent=require('../../scripts/manager-agent.cjs');
const report={status:'failed',sourceCommit:process.env.GITHUB_SHA,checks:[]},children=[],servers=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'0.0.0.0',r));return server.address().port}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'0.0.0.0',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function request(url,ca){return new Promise((resolve,reject)=>{const req=(ca?https:http).get(url,{ca,rejectUnauthorized:true,timeout:5000},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text}))});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('request timed out')));})}
async function until(operation){const end=Date.now()+30000;let last;while(Date.now()<end){try{return await operation()}catch(e){last=e;await wait(500)}}throw last}
async function start(config,env){const child=cp.spawn(binary,['run','--config',config,'--adapter','caddyfile'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});children.push(child);let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);child.on('exit',code=>{if(code)console.error(log.slice(-3000))});return child}
async function run(){
  await fs.mkdir(root+'/results',{recursive:true});await fs.mkdir(root+'/logs',{recursive:true});
  const ip=Object.values(os.networkInterfaces()).flat().map(x=>x?.address).find(a=>{try{return lan.lanAddress(a).family===4}catch{return false}});assert.ok(ip,'Disposable VM has a private LAN interface');
  const backend=await listen(http.createServer((req,res)=>res.end('institution app'))),peerPort=await freePort(),admin=await freePort(),httpPort=await freePort(),tlsPort=await freePort();
  const env={...process.env,XDG_DATA_HOME:root+'/data',XDG_CONFIG_HOME:root+'/config'},storage=root+'/storage';
  process.env.CADDY_EXE=binary;process.env.CADDYFILE_PATH=root+'/Caddyfile';process.env.CADDY_PATH=root;
  const peer=`http://127.0.0.1:${peerPort} {\n respond "existing site preserved"\n}\n`;
  const initial=`{\n admin 127.0.0.1:${admin}\n auto_https disable_redirects\n skip_install_trust\n http_port ${httpPort}\n storage file_system {\n root ${storage}\n }\n}\n`+peer;
  await fs.writeFile(root+'/Caddyfile',initial);await start(root+'/Caddyfile',env);
  await until(async()=>assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved'));
  const caddy=load('lib/caddy.ts',{'./exec':{runCommand:async(command)=>{try{const r=await exec(command,{env,windowsHide:true,timeout:30000});return{code:0,output:r.stdout+r.stderr}}catch(e){return{code:e.code||1,output:e.stderr||e.message}}}},'./paths':{webRoot:()=>root,caddyLogDir:()=>root+'/logs'},'./manager-address':require('../../lib/manager-address.ts'),'./db':{query:async()=>({rows:[]})}});
  const address=lan.lanAddress(ip,tlsPort).authority;
  await caddy.updateCaddyStrict(address,backend);
  const ca=await fs.readFile(storage+'/pki/authorities/local/root.crt');
  process.env.CADDY_ADMIN=`127.0.0.1:${admin}`;
  const caInfo=await fetch(`http://${process.env.CADDY_ADMIN}/pki/ca/local`,{headers:{Origin:`http://${process.env.CADDY_ADMIN}`}});assert.equal(caInfo.status,200,await caInfo.clone().text());
  const caDetails=await caInfo.json();assert.equal(typeof caDetails.root_certificate,'string',JSON.stringify(Object.keys(caDetails)));
  assert.equal((await require('../../scripts/server-monitor.cjs').checkHttp('Caddy',`http://${process.env.CADDY_ADMIN}/config/`)).ok,true,'Caddy health inspection includes its required local Origin');
  const certificateRoute=load('app/api/system/local-ca/route.ts',{'@/lib/auth':{getSessionFromCookie:async()=>({role:'admin'})},'@/lib/rbac':{requireRole:()=>{}},'@/lib/api':{ApiError:Error,jsonError:error=>{throw error}}});
  const certificateResponse=await certificateRoute.GET();assert.equal(certificateResponse.status,200);assert.match(certificateResponse.headers.get('Content-Disposition'),/attachment/);
  const downloadedCa=await certificateResponse.text();assert.equal(new(require('node:crypto').X509Certificate)(downloadedCa).fingerprint256,new(require('node:crypto').X509Certificate)(ca).fingerprint256);assert.ok(!downloadedCa.includes('PRIVATE KEY'));
  await until(async()=>assert.deepEqual(await request('https://'+address,downloadedCa),{status:200,body:'institution app'}));
  assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  const before=await fs.readFile(root+'/Caddyfile','utf8');assert.ok(before.includes(peer.trim()));
  const occupied=await listen(net.createServer(socket=>socket.end()));
  await assert.rejects(caddy.updateCaddyStrict(lan.lanAddress(ip,occupied).authority,backend));
  assert.equal(await fs.readFile(root+'/Caddyfile','utf8'),before);assert.equal((await request('https://'+address,ca)).body,'institution app');assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  report.checks.push({path:'Manager host',privateIp:ip,httpsVerifiedWithRootCA:true,publicCertificateDownloadVerified:true,existingSitePreserved:true,occupiedPortRejectedAndSitesPreserved:true});
  const remotePort=await freePort(),remoteAdmin=await freePort(),remoteStorage=root+'/remote-storage';
  const remoteAddress=lan.lanAddress(ip,remotePort).authority;
  let config=agent.caddyConfig([{name:'Institution app',repo_url:'https://example.com/institution/app',branch:'main',start_cmd:'node app.cjs',port:backend,access_mode:'lan',hostname:remoteAddress}],remoteStorage);
  config=config.replace('admin 127.0.0.1:2029',`admin 127.0.0.1:${remoteAdmin}\n auto_https disable_redirects`);
  await fs.writeFile(root+'/remote-Caddyfile',config);await start(root+'/remote-Caddyfile',env);
  const remoteCa=await until(()=>fs.readFile(remoteStorage+'/pki/authorities/local/root.crt'));
  await until(async()=>assert.deepEqual(await request('https://'+remoteAddress,remoteCa),{status:200,body:'institution app'}));
  assert.equal((await request('https://'+address,ca)).body,'institution app');assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  report.checks.push({path:'remote agent',httpsVerifiedWithSeparateRootCA:true,ipOnlyNoDns:true,existingSitesPreserved:true});
  await caddy.removeFromCaddyStrict(address);assert.ok((await fs.readFile(root+'/Caddyfile','utf8')).includes(peer.trim()));assert.ok(!(await fs.readFile(root+'/Caddyfile','utf8')).includes(address));assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  report.status='passed';
}
run().catch(error=>{report.error=error.message;console.error(error);process.exitCode=1}).finally(async()=>{for(const child of children)child.kill();for(const server of servers)server.close();await fs.mkdir(root+'/results',{recursive:true});await fs.writeFile(root+'/results/lan-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));});
