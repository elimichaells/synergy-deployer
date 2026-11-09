const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const load=require('./server-module.cjs'),lan=require('../scripts/lan-address.cjs'),agent=require('../scripts/manager-agent.cjs');
const app={name:'Institution library',repo_url:'https://example.com/org/library',branch:'main',start_cmd:'node app.cjs',port:3000,access_mode:'lan',hostname:'192.168.10.20:8443'};
test('private address validation preserves IPv4 and IPv6 and rejects unsafe or public targets',()=>{
  assert.equal(lan.lanAddress('192.168.10.20',8443).url,'https://192.168.10.20:8443');
  assert.equal(lan.lanAddress('fd12:0:0::1234',443).authority,'[fd12::1234]');
  for(const address of ['127.0.0.1','0.0.0.0','8.8.8.8','172.15.0.1','172.32.0.1','169.254.1.1','192.168.01.1','192.168.1.999','localhost','10.0.0.1\nimport bad','10.0.0.1@evil.test','[fe80::1%eth0]','[::ffff:192.168.1.1]'])assert.equal(lan.parseLanAddress(address),null,address);
  for(const port of [0,80,1023,65536,'8443/path','8443#x'])assert.throws(()=>lan.lanAddress('10.0.0.1',port));
  assert.throws(()=>lan.assertLanInterface('10.0.0.1:8443',{Ethernet:[{address:'10.0.0.2'}]}),/not assigned/);
  lan.assertLanInterface('10.0.0.1:8443',{Ethernet:[{address:'10.0.0.1'}]});
});
test('IP-only remote apps have no dummy hostname and gate older agents',()=>{
  const config=agent.validateApp(app);assert.equal(config.hostname,app.hostname);assert.equal(config.ip_port,8443);assert.equal(config.ip_address,'');
  assert.throws(()=>agent.validateApp({...app,access_mode:'wan'}),/LAN access/);
  assert.throws(()=>agent.validateApp({...app,port:8443}),/differ/);
  assert.throws(()=>agent.validateLanSelection(app.hostname,{capabilities:[]}),/Update/);
  agent.validateLanSelection(app.hostname,{capabilities:[agent.LAN_CAPABILITY]});
});
test('local and remote LAN routes use internal TLS and put the network denial before every app route',()=>{
  const caddy=load('lib/caddy.ts',{'./exec':{},'./paths':{webRoot:()=>'/fixture',caddyLogDir:()=>'/fixture/logs'},'./manager-address':require('../lib/manager-address.ts')});
  for(const text of [caddy.renderCaddyBlock(app.hostname,3000,[{path_prefix:'/api',port:3001,strip_prefix:true}]),agent.caddyConfig([app],'/isolated/storage')]){
    assert.match(text,/tls internal/);assert.match(text,/@outsideLan not remote_ip/);assert.match(text,/handle @outsideLan \{/);assert.match(text,/respond "Institution network access only" 403/);
    assert.ok(text.indexOf('handle @outsideLan')<text.indexOf('reverse_proxy'));assert.match(text,/\n\thandle \{/);
    assert.doesNotMatch(text,/\bbind |client_ip|@outsideLan[^\n]*header|cloudflare/i,'LAN route must not shadow an existing shared listener or trust forged forwarding headers');
  }
});
test('LAN creation never calls Cloudflare and preserves a separate existing project address',async()=>{
  const calls=[],projectId='project',name='192.168.10.20:8443';
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const query=async(sql,args=[])=>{calls.push({sql,args});if(sql.startsWith('select name,port'))return{rows:[{name:'Library',port:3000}]};if(sql.startsWith('insert into project_domains'))return{rows:[{id:'lan'}]};if(sql.includes('select pd.*'))return{rows:[{id:'lan',hostname:name,dns_status:'lan'}]};return{rows:[]}};
  const cf=load('lib/cloudflare.ts',{'@/lib/managed-servers':{ensureManagedServers:async()=>{}},'@/lib/api':{ApiError},'@/lib/db':{query},'@/lib/secret-crypto':{},'@/lib/caddy':{updateCaddyStrict:async(host,port)=>calls.push({host,port})},'node:os':{networkInterfaces:()=>({Ethernet:[{address:'192.168.10.20'}]})}});
  const result=await cf.createProjectDomain(projectId,{mode:'lan',lanIp:'192.168.10.20',lanPort:8443,isPrimary:true});
  assert.equal(result.hostname,name);assert.ok(calls.some(c=>c.host===name&&c.port===3000));
  assert.ok(calls.filter(c=>c.sql?.startsWith('update project_domains')).every(c=>c.sql.includes('where project_id=$1')&&c.args[0]===projectId));
  await assert.rejects(cf.createProjectDomain(projectId,{mode:'lan',lanIp:'10.0.0.9',lanPort:8443}),/not assigned/);
});

test('LAN application proxies protect Manager cookies on every stack route and retain the Host port',()=>{
  const caddy=load('lib/caddy.ts',{'./exec':{},'./paths':{webRoot:()=>'/fixture',caddyLogDir:()=>'/fixture/logs'},'./manager-address':require('../lib/manager-address.ts')});
  const text=caddy.renderCaddyBlock(app.hostname,3000,[{path_prefix:'/api',port:3001,strip_prefix:true}]);
  assert.equal((text.match(/header_up Cookie/g)||[]).length,2);
  assert.equal((text.match(/header_down Set-Cookie/g)||[]).length,2);
  assert.equal((text.match(/header_up Host \{http.request.hostport\}/g)||[]).length,2);
  assert.doesNotMatch(caddy.renderCaddyBlock('app.example.com',3000),/manager_session/);
});
test('rejected Caddy reload restores exact file bytes and leaves other sites present',async()=>{
  let file='existing.example.com {\r\n\treverse_proxy 127.0.0.1:9000\r\n}\r\n';const before=file;let reloads=0;
  const caddy=load('lib/caddy.ts',{'../scripts/lan-listener.cjs':{checkLanListeners:async()=>{}},'./exec':{runCommand:async(command)=>command.includes(' reload ')?(reloads++,{code:1,output:'address already in use'}):{code:0,output:'valid'}},'./paths':{webRoot:()=>'/fixture',caddyLogDir:()=>'/fixture/logs'},'./manager-address':require('../lib/manager-address.ts'),'./db':{query:async()=>({rows:[]})},'fs/promises':{mkdtemp:async()=>'/candidate',rm:async()=>{},readFile:async()=>file,writeFile:async(name,content)=>{if(!name.includes('candidate'))file=content}}});
  await assert.rejects(caddy.updateCaddyStrict(app.hostname,3000),/address already in use/);assert.equal(file,before);assert.equal(reloads,1);
});
test('unattended local HTTPS preserves existing global options and sites without interactive CA installation',()=>{
  const {nonInteractiveLocalTls}=load('lib/caddy.ts',{'./exec':{},'./paths':{webRoot:()=>'/fixture',caddyLogDir:()=>'/fixture/logs'},'./manager-address':require('../lib/manager-address.ts')});
  const site='192.168.1.2:8443 {\n tls internal\n reverse_proxy 127.0.0.1:3000\n}\n';
  for(const prefix of ['', '# existing sites\n', '\uFEFF# preserved\r\n{\r\n admin 127.0.0.1:2019\r\n}\r\n']){
    const result=nonInteractiveLocalTls(prefix+site);
    assert.match(result,/skip_install_trust/);assert.ok(result.endsWith(site));
    assert.equal(nonInteractiveLocalTls(result),result);
    if(prefix.includes('admin'))assert.match(result,/admin 127\.0\.0\.1:2019/);
  }
  const publicSite='example.com {\n reverse_proxy 127.0.0.1:3000\n}\n';assert.equal(nonInteractiveLocalTls(publicSite),publicSite);
});
test('standalone downloaded agent embeds private address rules without repository dependencies',async()=>{
  const source=await require('../scripts/agent-bundle.cjs').agentBundle();
  assert.ok(!source.includes("require('./lan-address.cjs')"));assert.match(source,/lan-ip-v1/);new(require('node:vm').Script)(source);
});
test('a running proxy without its local CA cannot return an unrelated certificate from disk',async t=>{
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  let diskReads=0;
  const previous=global.fetch;t.after(()=>{global.fetch=previous});
  const route=load('app/api/system/local-ca/route.ts',{'node:fs/promises':{readFile:async()=>{diskReads++;throw Error('Stale certificate must not be read')}},'@/lib/auth':{getSessionFromCookie:async()=>({role:'admin'})},'@/lib/rbac':{requireRole:()=>{}},'@/lib/api':{ApiError,jsonError:error=>{throw error}}});
  global.fetch=async()=>new Response('{}',{status:404});
  await assert.rejects(route.GET(),/running proxy has no local CA/);
  global.fetch=async()=>Response.json({root_certificate:'invalid certificate'});
  await assert.rejects(route.GET(),/valid public CA/);assert.equal(diskReads,0);
});
