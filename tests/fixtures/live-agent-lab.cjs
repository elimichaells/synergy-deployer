'use strict';
// Every network listener, checkout, certificate, PM2 socket and Caddy state is
// private to this disposable lab. No service registration or production config.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),https=require('node:https'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),agent=require('../../scripts/manager-agent.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
async function lab(t){
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'manager-live-agent-')),cleanup=[];
  const pm2=path.resolve(process.env.TEST_PM2_PACKAGE_ROOT,'bin/pm2'),caddy=path.resolve(process.env.TEST_CADDY),env=await agent.privatePm2Environment(root,pm2);
  const pm=args=>agent.run(process.execPath,[pm2,...args],{env,timeout:30000});
  t.after(async()=>{for(const fn of cleanup.reverse())await fn();assert.equal(path.dirname(root),temp);assert.equal(await fs.realpath(root),root);await fs.rm(root,{recursive:true,force:true});});
  cleanup.push(async()=>{if(await fs.stat(path.join(root,'pm2/pm2.pid')).catch(()=>null))await pm(['kill']);});
  const git=cp.execFileSync(process.platform==='win32'?'where.exe':'which',['git'],{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/)[0];
  const run=(args,cwd)=>agent.run(git,args,{cwd,timeout:30000});
  const seed=path.join(root,'seed'),repos=path.join(root,'repositories'),bare=path.join(repos,'team','application.git');await fs.mkdir(seed);await fs.mkdir(path.dirname(bare),{recursive:true});
  await run(['init','-b','main'],seed);await run(['config','user.name','Fixture'],seed);await run(['config','user.email','fixture@example.test'],seed);
  const initial={
    'app.cjs':"const http=require('node:http'),fs=require('node:fs');http.createServer((q,s)=>{s.writeHead(process.env.FAIL_HEALTH==='yes'?503:200,{'Content-Type':'application/json'});s.end(JSON.stringify({version:fs.readFileSync('version.txt','utf8'),database:process.env.DATABASE_URL||null}));}).listen(Number(process.env.PORT),'127.0.0.1');\n",
    'worker.cjs':"const fs=require('node:fs');setInterval(()=>{fs.mkdirSync('uploads',{recursive:true});fs.writeFileSync('uploads/worker.txt',fs.readFileSync('version.txt','utf8'));},200);\n",
    'version.txt':'one','.gitignore':'uploads/\n.env*\n',
  };
  for(const [name,value]of Object.entries(initial))await fs.writeFile(path.join(seed,name),value);
  await run(['add','.'],seed);await run(['commit','-m','initial'],seed);await run(['clone','--bare',seed,bare]);await run(['-C',bare,'config','http.receivepack','true']);
  const openssl=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:\\Program Files','Git','usr/bin/openssl.exe'):'openssl',key=path.join(root,'fixture.key'),cert=path.join(root,'fixture.pem');
  await agent.run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],{timeout:30000});
  const ca=await fs.readFile(cert,'utf8'),username='fixture',token='disposable-git-token',backend=path.join(await run(['--exec-path']),process.platform==='win32'?'git-http-backend.exe':'git-http-backend');
  let origin,pushes=0;
  const server=https.createServer({key:await fs.readFile(key),cert:ca},async(req,res)=>{try{
    const url=new URL(req.url,origin);if(req.headers.authorization!=='Basic '+Buffer.from(username+':'+token).toString('base64')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});res.end();return;}
    if(url.pathname.endsWith('/git-receive-pack'))pushes++;
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks),child=cp.spawn(backend,[],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:String(body.length),REMOTE_USER:username,REMOTE_ADDR:'127.0.0.1',HTTP_GIT_PROTOCOL:req.headers['git-protocol']||''}}),output=[];
    child.stdout.on('data',b=>output.push(b));child.stderr.resume();child.on('error',()=>{res.writeHead(500);res.end();});child.on('close',()=>{const bytes=Buffer.concat(output),at=bytes.indexOf('\r\n\r\n');if(at<0){res.writeHead(500);res.end();return;}for(const line of bytes.subarray(0,at).toString().split('\r\n')){const i=line.indexOf(':');if(i<0)continue;const k=line.slice(0,i),v=line.slice(i+1).trim();if(k.toLowerCase()==='status')res.statusCode=Number(v.split(' ')[0]);else res.setHeader(k,v);}res.end(bytes.subarray(at+4));});child.stdin.end(body);
  }catch{res.writeHead(500);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='https://127.0.0.1:'+server.address().port;cleanup.push(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const adminPort=await freePort(),existingPort=await freePort(),admin='http://127.0.0.1:'+adminPort,configPath=path.join(root,'legacy','Caddyfile'),candidatePath=path.join(root,'legacy','candidate'),sites=path.join(root,'managed-sites');await fs.mkdir(sites);await fs.mkdir(path.dirname(configPath));
  const source=`{\n admin 127.0.0.1:${adminPort} {\n origins ${admin}\n enforce_origin\n }\n auto_https disable_redirects\n skip_install_trust\n}\nhttp://127.0.0.1:${existingPort} {\n respond "preserved-site" 200\n}\nimport ${JSON.stringify(path.join(sites,'*.caddy').replaceAll('\\','/'))}\n`;
  await fs.writeFile(configPath,source);await fs.writeFile(candidatePath,'');await agent.atomicJson(path.join(root,'proxy.json'),{mode:'existing-caddy',configPath,candidatePath,admin,sourceHash:createHash('sha256').update(source).digest('hex'),reservedHosts:['existing.example.test'],reservedPorts:[existingPort]});
  const proxy=cp.spawn(caddy,['run','--config',configPath,'--adapter','caddyfile'],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,XDG_DATA_HOME:path.join(root,'caddy-data'),XDG_CONFIG_HOME:path.join(root,'caddy-config')}});let proxyError='';proxy.stderr.on('data',b=>proxyError=(proxyError+b).slice(-3000));
  cleanup.push(async()=>{if(proxy.exitCode===null){await fetch(admin+'/stop',{method:'POST',headers:{Origin:admin}}).catch(()=>proxy.kill());await new Promise(r=>{if(proxy.exitCode!==null)return r();proxy.once('close',r)});}});
  for(let i=0;i<100;i++){if((await fetch(admin+'/config/',{headers:{Origin:admin}}).catch(()=>null))?.ok)break;if(i===99)throw Error(proxyError||'Fixture Caddy did not start');await pause(100);}
  // Shared Caddy still performs its real ownership checks and reload. Test routes
  // use separate loopback ports instead of competing for the production 443.
  const ports=new Map(),proxyConfig=async(r,text,tools)=>{for(const [hostname,port]of ports)text=text.replaceAll('https://'+hostname,'https://127.0.0.1:'+port);return agent.proxyConfig(r,text,tools)};
  const secure=async port=>{const ca=await fs.readFile(path.join(root,'caddy-data','caddy','pki','authorities','local','root.crt'));return new Promise((resolve,reject)=>{https.get('https://127.0.0.1:'+port,{ca},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));}).on('error',reject);});};
  const tools={pm,caddy,tools:{git:'fixture',caddy:'fixture'}};
  return{root,seed,bare,tools,run,pm,git,ca,repo:origin+'/team/application.git',gitCredential:{username,token,caPem:ca},existingPort,configPath,source,pushes:()=>pushes,freePort,pause,ports,proxyConfig,secure};
}
module.exports={lab,freePort,pause};
