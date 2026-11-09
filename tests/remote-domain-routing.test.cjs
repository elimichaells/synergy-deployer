const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),cp=require('node:child_process');
const {randomUUID}=require('node:crypto'),agent=require('../scripts/manager-agent.cjs');
const app=(id,hostname,port)=>({id,name:hostname,repo_url:'https://example.com/org/app',branch:'main',start_cmd:'node app.cjs',health_path:'/',port,hostname,access_mode:'wan',ip_address:'',ip_port:null});
const temporary=async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-domain-routing-'));t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'manager-domain-routing-')));await fs.rm(root,{recursive:true,force:true})});return root};
test('shared domain paths follow the current target release and prevent detaching either dependency',async t=>{
  const root=await temporary(t),front=app(randomUUID(),'front.example.com',33101),back=app(randomUUID(),'back.example.com',33102),domainId=randomUUID();
  const saved={[front.id]:{app:front},[back.id]:{app:back}},domains={[domainId]:{appId:front.id,hostname:front.hostname,paths:[{id:randomUUID(),appId:back.id,prefix:'/api',stripPrefix:true}]}};
  await agent.atomicJson(path.join(root,'apps.json'),saved);await agent.atomicJson(path.join(root,'domains.json'),domains);
  const config=await agent.managedCaddyConfig(root,[front,back]);assert.match(config,/path \/api \/api\/\*/);assert.match(config,/uri strip_prefix \/api/);assert.match(config,/127.0.0.1:33102/);
  for(const id of [front.id,back.id])await assert.rejects(agent.infrastructureJob(root,{payload:{action:'detach',id,expiresAt:Date.now()+60000}},{},()=>{}),/Remove shared domain paths/);
  const moved=await agent.managedCaddyConfig(root,[front,{...back,port:33103}]);assert.match(moved,/127.0.0.1:33103/);assert.doesNotMatch(moved,/33102/);
  await assert.rejects(agent.managedCaddyConfig(root,[front]),/target is unavailable/);
  for(const prefix of ['/api\nfile_server','/api/*','/../secret','/.well-known/acme-challenge'])assert.throws(()=>agent.caddyConfig([{...front,pathRoutes:[{prefix,port:33102,stripPrefix:true}]}],root),/Invalid shared domain path/);
});
test('real isolated Caddy routes exact paths, nested prefixes and strips only the selected prefix', {skip:!process.env.MANAGER_CADDY_TEST_EXE},async t=>{
  const binary=process.env.MANAGER_CADDY_TEST_EXE;assert.ok(path.isAbsolute(binary));const root=await temporary(t),servers=[];
  const listen=async name=>{const s=http.createServer((req,res)=>res.end(name+':'+req.url));servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port};
  const frontPort=await listen('front'),apiPort=await listen('api'),nestedPort=await listen('nested');
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const listenPort=reservation.address().port;await new Promise(r=>reservation.close(r));
  let config=agent.caddyConfig([{...app(randomUUID(),'front.example.com',frontPort),pathRoutes:[{prefix:'/api',port:apiPort,stripPrefix:true},{prefix:'/api/v2',port:nestedPort,stripPrefix:false}]}],path.join(root,'storage'));
  config=config.replace('admin 127.0.0.1:2029','admin off\n auto_https off').replace('https://front.example.com',`http://127.0.0.1:${listenPort}`);
  const file=path.join(root,'Caddyfile');await fs.writeFile(file,config);
  const child=cp.spawn(binary,['run','--config',file,'--adapter','caddyfile'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')}});let output='';child.stdout.on('data',b=>{output=(output+b).slice(-8000)});child.stderr.on('data',b=>{output=(output+b).slice(-8000)});
  const ended=new Promise(resolve=>{child.on('exit',resolve);child.on('error',resolve)});
  t.after(async()=>{child.kill();await ended;for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r))}});
  const get=async suffix=>{const response=await fetch(`http://127.0.0.1:${listenPort}${suffix}`,{signal:AbortSignal.timeout(1500)});return response.text()};
  const deadline=Date.now()+10000;let ready=false;
  while(Date.now()<deadline){try{if(await get('/')==='front:/'){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.ok(ready,output);
  assert.equal(await get('/about'),'front:/about');assert.equal(await get('/api'),'api:/');assert.equal(await get('/api/users?active=1'),'api:/users?active=1');assert.equal(await get('/api/v2/users'),'nested:/api/v2/users');assert.equal(await get('/apiary'),'front:/apiary');
});
