'use strict';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.MANAGER_LAN_LAB!=='1'||process.platform!=='win32')throw Error('LAN acceptance lab requires a disposable hosted Windows VM');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),https=require('node:https'),net=require('node:net'),cp=require('node:child_process'),{promisify}=require('node:util'),assert=require('node:assert/strict');
const exec=promisify(cp.exec),root='C:/ManagerLanLab',binary=root+'/bin/caddy.exe',load=require('../server-module.cjs'),lan=require('../../scripts/lan-address.cjs'),agent=require('../../scripts/manager-agent.cjs');
const report={status:'failed',sourceCommit:process.env.GITHUB_SHA,checks:[]},children=[],servers=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'0.0.0.0',r));return server.address().port}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'0.0.0.0',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function request(url,ca,headers){return new Promise((resolve,reject)=>{const req=(ca?https:http).get(url,{ca,headers,rejectUnauthorized:true,timeout:5000},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,...(headers?{headers:res.headers}:{})}))});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('request timed out')));})}
async function verifyApplicationHeaders(address,ca){
  const response=await request('https://'+address+'/headers',ca,{Cookie:'manager_session=secret; application_session=kept; manager_session=duplicate; preference=dark'});
  assert.equal(response.status,200);const headers=JSON.parse(response.body);
  assert.equal(headers.host,address,'The application receives its HTTPS port');
  assert.ok(!headers.cookie.includes('manager_session'),'The application cannot read the Manager session');
  assert.ok(headers.cookie.includes('application_session=kept'));assert.ok(headers.cookie.includes('preference=dark'));
  const cookies=response.headers['set-cookie']||[];
  assert.ok(!cookies.some(cookie=>/manager_session=/.test(cookie)),'The application cannot overwrite the Manager session');
  assert.ok(cookies.includes('application_session=updated; Secure; HttpOnly; Path=/'));
}
async function until(operation){const end=Date.now()+30000;let last;while(Date.now()<end){try{return await operation()}catch(e){last=e;await wait(500)}}throw last}
async function start(config,env){const child=cp.spawn(binary,['run','--config',config,'--adapter','caddyfile'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']});children.push(child);let log='';child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);child.on('exit',code=>{if(code)console.error(log.slice(-3000))});return child}
async function run(){
  await fs.mkdir(root+'/results',{recursive:true});await fs.mkdir(root+'/logs',{recursive:true});
  const ip=Object.values(os.networkInterfaces()).flat().map(x=>x?.address).find(a=>{try{return lan.lanAddress(a).family===4}catch{return false}});assert.ok(ip,'Disposable VM has a private LAN interface');
  const backend=await listen(http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/headers'){res.setHeader('Set-Cookie',['manager_session=overwrite; Secure; HttpOnly; Path=/','application_session=updated; Secure; HttpOnly; Path=/']);return res.end(JSON.stringify({host:req.headers.host,cookie:req.headers.cookie||''}))}res.end(url.pathname==='/api/manager-health'?JSON.stringify({ready:true,version:'2.31.0',nonce:url.searchParams.get('nonce')}):'institution app')})),peerPort=await freePort(),admin=await freePort(),httpPort=await freePort(),tlsPort=await freePort();
  const env={...process.env,XDG_DATA_HOME:root+'/data',XDG_CONFIG_HOME:root+'/config'},storage=root+'/storage';
  process.env.CADDY_EXE=binary;process.env.CADDYFILE_PATH=root+'/Caddyfile';process.env.CADDY_PATH=root;
  const peer=`http://127.0.0.1:${peerPort} {\n respond "existing site preserved"\n}\n`;
  const initial=`{\n admin 127.0.0.1:${admin}\n auto_https disable_redirects\n http_port ${httpPort}\n storage file_system {\n root ${storage}\n }\n}\n`+peer;
  await fs.writeFile(root+'/Caddyfile',initial);await start(root+'/Caddyfile',env);
  await until(async()=>assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved'));
  const caddy=load('lib/caddy.ts',{'./exec':{runCommand:async(command)=>{try{const r=await exec(command,{env,windowsHide:true,timeout:30000});return{code:0,output:r.stdout+r.stderr}}catch(e){return{code:e.code||1,output:e.stderr||e.message}}}},'./paths':{webRoot:()=>root,caddyLogDir:()=>root+'/logs'},'./manager-address':require('../../lib/manager-address.ts'),'./db':{query:async()=>({rows:[]})}});
  const address=lan.lanAddress(ip,tlsPort).authority;
  await caddy.updateCaddyStrict(address,backend);
  assert.match(await fs.readFile(root+'/Caddyfile','utf8'),/skip_install_trust/,'The first LAN route suppresses interactive trust-store installation');
  const ca=await fs.readFile(storage+'/pki/authorities/local/root.crt');
  process.env.CADDY_ADMIN=`127.0.0.1:${admin}`;
  const caInfo=await fetch(`http://${process.env.CADDY_ADMIN}/pki/ca/local`,{headers:{Origin:`http://${process.env.CADDY_ADMIN}`}});assert.equal(caInfo.status,200,await caInfo.clone().text());
  const caDetails=await caInfo.json();assert.equal(typeof caDetails.root_certificate,'string',JSON.stringify(Object.keys(caDetails)));
  assert.equal((await require('../../scripts/server-monitor.cjs').checkHttp('Caddy',`http://${process.env.CADDY_ADMIN}/config/`)).ok,true,'Caddy health inspection includes its required local Origin');
  const certificateRoute=load('app/api/system/local-ca/route.ts',{'@/lib/auth':{getSessionFromCookie:async()=>({role:'admin'})},'@/lib/rbac':{requireRole:()=>{}},'@/lib/api':{ApiError:Error,jsonError:error=>{throw error}}});
  const certificateResponse=await certificateRoute.GET();assert.equal(certificateResponse.status,200);assert.match(certificateResponse.headers.get('Content-Disposition'),/attachment/);
  const downloadedCa=await certificateResponse.text();assert.equal(new(require('node:crypto').X509Certificate)(downloadedCa).fingerprint256,new(require('node:crypto').X509Certificate)(ca).fingerprint256);assert.ok(!downloadedCa.includes('PRIVATE KEY'));
  await until(async()=>assert.deepEqual(await request('https://'+address,downloadedCa),{status:200,body:'institution app'}));
  await verifyApplicationHeaders(address,downloadedCa);
  const {verifyProxy}=require('../../scripts/verify-manager-installation.cjs');
  const proxyOptions={origin:'https://'+address,caFile:storage+'/pki/authorities/local/root.crt',version:'2.31.0',timeoutMs:1500,pollMs:100};
  assert.deepEqual(await verifyProxy(proxyOptions),{httpsVerified:true});
  await assert.rejects(verifyProxy({...proxyOptions,version:'0.0.0'}),/expected ready Manager/);
  assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  const before=await fs.readFile(root+'/Caddyfile','utf8');assert.ok(before.includes(peer.trim()));
  const occupied=await listen(net.createServer(socket=>socket.end()));
  await assert.rejects(caddy.updateCaddyStrict(lan.lanAddress(ip,occupied).authority,backend));
  assert.equal(await fs.readFile(root+'/Caddyfile','utf8'),before);assert.equal((await request('https://'+address,ca)).body,'institution app');assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  report.checks.push({path:'Manager host',privateIp:ip,httpsVerifiedWithRootCA:true,hostPortPreserved:true,managerCookieProtected:true,publicCertificateDownloadVerified:true,existingSitePreserved:true,occupiedPortRejectedAndSitesPreserved:true});
  const remotePort=await freePort(),remoteAdmin=2029,remoteRoot=path.join(root,'remote-agent'),remoteStorage=path.join(remoteRoot,'caddy-storage');
  await fs.mkdir(remoteRoot,{recursive:true});
  const remoteAddress=lan.lanAddress(ip,remotePort).authority;
  let config=agent.caddyConfig([{name:'Institution app',repo_url:'https://example.com/institution/app',branch:'main',start_cmd:'node app.cjs',port:backend,access_mode:'lan',hostname:remoteAddress}],remoteStorage);
  config=config.replace('admin 127.0.0.1:2029',`admin 127.0.0.1:${remoteAdmin}\n auto_https disable_redirects`);
  await fs.writeFile(path.join(remoteRoot,'Caddyfile'),config);await start(path.join(remoteRoot,'Caddyfile'),env);
  const remoteCa=await until(()=>fs.readFile(remoteStorage+'/pki/authorities/local/root.crt'));
  await assert.rejects(verifyProxy({...proxyOptions,caFile:path.join(remoteStorage,'pki/authorities/local/root.crt')}),/HTTPS verification failed/);
  await until(async()=>assert.deepEqual(await request('https://'+remoteAddress,remoteCa),{status:200,body:'institution app'}));
  await verifyApplicationHeaders(remoteAddress,remoteCa);
  assert.equal((await request('https://'+address,ca)).body,'institution app');assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  await agent.proxyConfig(remoteRoot,config,{caddy:binary,tools:{caddy:true},pm:async()=> '[]'});
  assert.equal((await request('https://'+remoteAddress,remoteCa)).body,'institution app');
  report.checks.push({path:'remote agent',dedicatedProxyReloadVerified:true,hostPortPreserved:true,managerCookieProtected:true,httpsVerifiedWithSeparateRootCA:true,ipOnlyNoDns:true,existingSitesPreserved:true});
  // Reused Caddy retains its owner's global options and existing routes.
  const sharedRoot=root+'/shared-agent',sharedStorage=sharedRoot+'/storage',sharedAdmin=await freePort(),sharedPeerPort=await freePort(),sharedPort=await freePort();
  await fs.mkdir(sharedRoot+'/managed-sites',{recursive:true});
  const sharedConfig=sharedRoot+'/existing.Caddyfile',sharedCandidate=sharedRoot+'/candidate.pending',sharedOrigin=`http://127.0.0.1:${sharedAdmin}`;
  const sharedSource=`{\n admin 127.0.0.1:${sharedAdmin}\n auto_https disable_redirects\n storage file_system {\n root ${sharedStorage}\n }\n}\nhttp://127.0.0.1:${sharedPeerPort} {\n respond "shared existing site"\n}\nimport "${sharedRoot}/managed-sites/*.caddy"\n`;
  await fs.writeFile(sharedConfig,sharedSource);await fs.writeFile(sharedCandidate,'');await start(sharedConfig,env);
  await until(async()=>assert.equal((await request(`http://127.0.0.1:${sharedPeerPort}`)).body,'shared existing site'));
  const settings={mode:'existing-caddy',configPath:sharedConfig,candidatePath:sharedCandidate,admin:sharedOrigin,sourceHash:require('node:crypto').createHash('sha256').update(sharedSource).digest('hex'),reservedHosts:[],reservedPorts:[sharedPeerPort]};
  await fs.writeFile(sharedRoot+'/proxy.json',JSON.stringify(settings));
  const sharedAddress=lan.lanAddress(ip,sharedPort).authority;
  const sharedManaged=agent.caddyConfig([{name:'Shared LAN app',repo_url:'https://example.com/org/app',branch:'main',start_cmd:'node app.cjs',port:backend,access_mode:'lan',hostname:sharedAddress}],sharedRoot+'/unused-private-storage');
  const sharedTools={caddy:binary,tools:{caddy:true},pm:()=>{throw Error('Shared proxy must not start or stop another process')}};
  await assert.rejects(agent.proxyConfig(sharedRoot,sharedManaged,sharedTools),/skip_install_trust/);
  assert.equal(await fs.readFile(sharedConfig,'utf8'),sharedSource);assert.equal((await request(`http://127.0.0.1:${sharedPeerPort}`)).body,'shared existing site');
  // The lab acts as the existing proxy's administrator for this one-time setting.
  const prepared=sharedSource.replace('{\n','{\n skip_install_trust\n');await fs.writeFile(sharedConfig,prepared);
  await exec(`"${binary}" reload --config "${sharedConfig}" --adapter caddyfile --address 127.0.0.1:${sharedAdmin}`,{env,windowsHide:true,timeout:30000});
  settings.sourceHash=require('node:crypto').createHash('sha256').update(prepared).digest('hex');await fs.writeFile(sharedRoot+'/proxy.json',JSON.stringify(settings));
  await agent.proxyConfig(sharedRoot,sharedManaged,sharedTools);
  const sharedCa=await until(async()=>{const ca=await agent.publicCertificate(sharedRoot,{sharedProxy:settings});assert.match(ca||'',/BEGIN CERTIFICATE/);return ca});
  await until(async()=>assert.equal((await request('https://'+sharedAddress,sharedCa)).body,'institution app'));
  await verifyApplicationHeaders(sharedAddress,sharedCa);
  assert.equal(await fs.readFile(sharedConfig,'utf8'),prepared);assert.equal((await request(`http://127.0.0.1:${sharedPeerPort}`)).body,'shared existing site');
  report.checks.push({path:'reused remote Caddy',httpsVerified:true,hostPortPreserved:true,managerCookieProtected:true,activeCaDownload:true,interactiveTrustRejected:true,ownerConfigPreserved:true,existingSitePreserved:true});
  // Manager itself must retain its login cookie when it shares the app's IP.
  const originalManagerAddress=process.env.MANAGER_DOMAIN;process.env.MANAGER_DOMAIN=ip;
  try{
    await caddy.updateCaddyStrict(ip,backend);
    const response=await until(()=>request('https://'+ip+'/headers',ca,{Cookie:'manager_session=manager-login'}));
    assert.equal(response.status,200);assert.equal(JSON.parse(response.body).cookie,'manager_session=manager-login');
    assert.ok(response.headers['set-cookie'].some(cookie=>cookie.startsWith('manager_session=')));
    await caddy.removeFromCaddyStrict(ip);
    report.checks.push({path:'Manager private-IP sign-in route',sessionCookiePreserved:true});
  }finally{if(originalManagerAddress===undefined)delete process.env.MANAGER_DOMAIN;else process.env.MANAGER_DOMAIN=originalManagerAddress}
  await caddy.removeFromCaddyStrict(address);assert.ok((await fs.readFile(root+'/Caddyfile','utf8')).includes(peer.trim()));assert.ok(!(await fs.readFile(root+'/Caddyfile','utf8')).includes(address));assert.equal((await request(`http://127.0.0.1:${peerPort}`)).body,'existing site preserved');
  report.status='passed';
}
run().catch(error=>{report.error=error.message;console.error(error);process.exitCode=1}).finally(async()=>{for(const child of children)child.kill();for(const server of servers)server.close();await fs.mkdir(root+'/results',{recursive:true});await fs.writeFile(root+'/results/lan-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));});
