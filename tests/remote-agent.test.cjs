const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const agent = require('../scripts/manager-agent.cjs');
const fixture = overrides => ({name:'Library',repo_url:'https://github.com/example/library',branch:'main',install_cmd:'npm ci',build_cmd:'npm run build',start_cmd:'npm start',port:3100,health_path:'/health',access_mode:'lan',hostname:'library.campus.example.edu',environment:{DATABASE_URL:'postgres://app:secret@db/library'},...overrides});

test('unattended enrollment persists one credential across a failed response and refuses replacement',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-agent-enrollment-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const received=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(received.length===1?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(received.length===1?{error:'Temporary response failure'}:{ok:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const setup={manager:`http://127.0.0.1:${server.address().port}`,serverId:randomUUID(),enrollmentToken:'one-time-fixture-token'};
  const enrollmentFile=path.join(root,'enrollment.json');
  await fs.writeFile(enrollmentFile,JSON.stringify(setup),{mode:0o600});
  await assert.rejects(agent.enrollCli(root,{'enrollment-file':enrollmentFile}),/Temporary response failure/);
  const first=await agent.readJson(path.join(root,'agent.json'));
  assert.equal(first.enrolled,false);assert.ok(!JSON.stringify(first).includes(setup.enrollmentToken));
  await agent.enrollCli(root,{'enrollment-file':enrollmentFile});
  const second=await agent.readJson(path.join(root,'agent.json'));
  assert.equal(second.enrolled,true);assert.equal(second.agentToken,first.agentToken);
  assert.equal(received[0].agentToken,received[1].agentToken);
  await assert.rejects(agent.enrollCli(root,{'enrollment-file':enrollmentFile}),/already contains/);
  assert.equal(received.length,2);
});

test('remote apps validate paths, commands, environment and dedicated IP ports',()=>{
  assert.equal(agent.validateApp(fixture({ip_address:'10.0.0.2',ip_port:8443})).ip_port,8443);
  assert.equal(agent.validateApp(fixture({ip_address:'2001:db8::1',ip_port:8443})).ip_address,'2001:db8::1');
  for(const patch of [{repo_url:'https://secret@github.com/a/b'},{repo_url:'https://git.local/a/../b'},{repo_url:'file:///tmp/repo'},
    {branch:'--upload-pack=evil'},{branch:'a..b'},{hostname:'app.local { respond hi }'},{hostname:'*.example.edu'},
    {health_path:'//example.org'},{port:2029},{ip_address:'not-ip',ip_port:8443},{ip_address:'10.0.0.2',ip_port:3100},
    {environment:{PM2_HOME:'/tmp'}},{environment:{PATH:'/tmp'}},{environment:{NODE_OPTIONS:'--require evil'}},{environment:{TOKEN:123}},
    {access_mode:'wan',hostname:'app.local'},{environment:[]},{start_cmd:''}])assert.throws(()=>agent.validateApp(fixture(patch)),JSON.stringify(patch));
});

test('Caddy uses internal CA explicitly for LAN and IP, public certificates for WAN',()=>{
  const output=agent.caddyConfig([fixture({ip_address:'10.0.0.2',ip_port:8443}),fixture({name:'Public',hostname:'portal.example.edu',access_mode:'wan',port:3200}),
    fixture({name:'IPv6',hostname:'six.example.edu',port:3300,ip_address:'2001:db8::1',ip_port:8444})],'C:\\Agent Data\\caddy-storage');
  assert.match(output,/admin 127\.0\.0\.1:2029/);
  assert.match(output,/skip_install_trust/);
  assert.match(output,/https:\/\/library\.campus\.example\.edu \{\n\ttls internal\n\treverse_proxy 127\.0\.0\.1:3100/);
  assert.match(output,/https:\/\/portal\.example\.edu \{\n\treverse_proxy/);
  assert.match(output,/https:\/\/10\.0\.0\.2:8443 \{\n\ttls internal/);
  assert.match(output,/https:\/\/\[2001:db8::1\]:8444/);
  assert.ok(!output.includes('postgres://'));
});

test('agent refuses insecure cross-network URLs and redirects',async()=>{
  assert.equal(agent.managerAddress('https://manager.example.edu/'),'https://manager.example.edu');
  for(const value of ['http://10.0.0.1','https://user:secret@example.edu','https://example.edu/path','https://example.edu/?token=x'])assert.throws(()=>agent.managerAddress(value));
  let leaked=false;
  const destination=http.createServer((req,res)=>{leaked=true;res.end('{}');});
  await new Promise(r=>destination.listen(0,'127.0.0.1',r));
  const server=http.createServer((req,res)=>{res.writeHead(307,{Location:`http://127.0.0.1:${destination.address().port}`});res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await assert.rejects(agent.request({manager:`http://127.0.0.1:${server.address().port}`,agentToken:'secret'},'claim',{}));assert.equal(leaked,false);}
  finally{server.closeAllConnections();destination.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>destination.close(r))]);}
});

test('secrets spanning output chunks, truncated credentials and overlapping values are redacted',()=>{
  let output='';const redactor=agent.streamRedactor(['long-secret','secret'],x=>output+=x);
  redactor.write('prefix long-');redactor.write('secret and sec');redactor.write('ret then long-');redactor.end();
  assert.equal(output,'prefix [redacted] and [redacted] then [redacted]');
});

test('telemetry strips unexpected fields and rejects invalid capacity',()=>{
  const raw={hostname:'campus',platform:'linux',version:'1',cpuPercent:30,memoryTotal:100,memoryFree:50,diskTotal:200,diskFree:100,uptime:10,
    addresses:['10.0.0.1','secret'],tools:{node:'v22',git:'git',pm2:'6',caddy:'2'},environment:{SECRET:'hidden'},apps:[]};
  const clean=agent.sanitizeMetrics(raw);
  assert.deepEqual(clean.addresses,['10.0.0.1']);assert.equal(clean.environment,undefined);
  for(const patch of [{cpuPercent:NaN},{cpuPercent:101},{memoryFree:101},{diskFree:201},{platform:'darwin'}])assert.throws(()=>agent.sanitizeMetrics({...raw,...patch}));
});

test('agent rejects directory escape and linked paths',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'remote-path-test-'));
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'remote-path-other-'));
  try{
    await assert.rejects(agent.contained(root,'..','escaped'));
    await fs.symlink(other,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(agent.contained(root,'link','child'),/symlink|junction/);
  }finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(other,{recursive:true,force:true});}
});

async function harness(t, failure) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'remote-deploy-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const appId=randomUUID(),jobId=randomUUID(),commit='b'.repeat(40),events=[];
  const oldApp=fixture({id:appId,environment:{},hostname:'old.campus.example.edu'});
  const prior={app:oldApp,ecosystem:path.join(root,'prior.config.js'),commit:'a'.repeat(40)};
  await agent.atomicJson(path.join(root,'apps.json'),{[appId]:prior});
  let processes=[{name:`manager-remote-${appId}`}];
  const tools={tools:{git:'git',caddy:'caddy'},pm:async args=>{
    events.push(['pm',...args]);
    if(args[0]==='jlist')return JSON.stringify(processes);
    if(args[0]==='delete')processes=[];
    if(args[0]==='start')processes=[{name:`manager-remote-${appId}`}];
    return '';
  }};
  const dependencies={run:async(file,args,options)=>{
    events.push(['command',file]);
    if(file==='git'&&args[0]==='clone'){await fs.mkdir(args.at(-1));return '';}
    if(file==='git')return commit;
    assert.equal(options.env.DATABASE_URL,'postgres://app:secret@db/library');
    assert.equal(options.env.MANAGER_AGENT_TOKEN,undefined);
    if(failure==='build'&&file==='npm run build')throw new Error('Build failed');return '';
  },checkPort:async()=>{},healthy:async app=>{events.push(['health',app.hostname]);if(failure==='health'&&app.hostname!=='old.campus.example.edu')throw new Error('Health failed');},
  proxyConfig:async(_root,config)=>{events.push(['proxy',config]);if(failure==='proxy'&&config.includes('https://library.'))throw new Error('Invalid Caddy route');}};
  const job={id:jobId,payload:{...fixture({id:appId}),git:{username:'deploy',token:'git-fixture-secret'}}};
  const journal={id:jobId,appId,status:'running',log:''};
  const persist=async()=>{events.push(['journal']);await agent.atomicJson(path.join(root,'journal.json'),journal);};
  return{root,job,journal,tools,dependencies,events,prior,commit,persist,log:text=>journal.log+=text};
}

test('deployment builds separately, journals before activation, health-checks and then routes',async t=>{
  const h=await harness(t);
  assert.equal(await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),h.commit);
  const saved=await agent.readJson(path.join(h.root,'apps.json'));
  assert.equal(saved[h.job.payload.id].commit,h.commit);
  assert.deepEqual(saved[h.job.payload.id].app.environment,{});
  assert.equal(h.journal.activation.previousApps[h.job.payload.id].commit,'a'.repeat(40));
  assert.ok(h.events.findIndex(x=>x[0]==='journal')<h.events.findIndex(x=>x[0]==='pm'&&x[1]==='delete'));
  assert.ok(h.events.findIndex(x=>x[0]==='health')<h.events.findIndex(x=>x[0]==='proxy'));
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/refusing to replay/);
});

for(const stage of ['build','health','proxy'])test(`${stage} failure preserves or restores prior release and routing`,async t=>{
  const h=await harness(t,stage);
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies));
  const saved=await agent.readJson(path.join(h.root,'apps.json'));
  assert.equal(saved[h.job.payload.id].commit,'a'.repeat(40));
  if(stage==='build')assert.ok(!h.events.some(x=>x[0]==='pm'&&x[1]==='delete'));
  else {assert.ok(h.events.some(x=>x[0]==='pm'&&x[1]==='start'&&x[2]===h.prior.ecosystem));assert.match(h.events.filter(x=>x[0]==='proxy').at(-1)[1],/https:\/\/old\.campus/);}
});

test('startup recovery restores the journaled release without executing a build',async t=>{
  const h=await harness(t);
  h.journal.activation={previous:h.prior,previousApps:{[h.job.payload.id]:h.prior}};
  await agent.restoreActivation(h.root,h.journal,h.tools,h.log,h.dependencies);
  assert.ok(!h.events.some(x=>x[0]==='command'));
  assert.ok(h.events.some(x=>x[0]==='health'));
});
