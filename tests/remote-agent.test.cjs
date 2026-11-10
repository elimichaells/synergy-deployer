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

test('redaction is independent of chunk boundaries and never reprocesses replacement markers',()=>{
  const secrets=['token','token-secret','redacted',null,42],source='before token-secret then token after!';
  const expected='before [redacted] then [redacted] after!';
  assert.equal(agent.redact(source,secrets),expected);
  for(let split=0;split<=source.length;split++){
    let result='';const r=agent.streamRedactor(secrets,s=>result+=s);
    r.write(source.slice(0,split));r.write(source.slice(split));r.end();
    assert.equal(result,expected,'chunk boundary '+split);
  }
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
  const priorRoot=path.join(root,'releases',appId,randomUUID());await fs.mkdir(priorRoot,{recursive:true});
  const prior={app:oldApp,ecosystem:path.join(root,'prior.config.js'),commit:'a'.repeat(40)};
  await agent.atomicJson(path.join(root,'launch.json'),{cwd:priorRoot,env:{}});
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

async function auditedHarness(t, reports, gate) {
  const h=await harness(t),run=h.dependencies.run;
  h.job.payload.securityGate=gate||{off:false};
  h.dependencies.run=async(file,args,options)=>{
    if(file.startsWith('npm audit')){h.events.push(['audit']);return reports.length>1?reports.shift():reports[0];}
    const result=await run(file,args,options);
    if(file==='git'&&args[0]==='clone'){
      await fs.writeFile(path.join(args.at(-1),'package.json'),'{}');
      await fs.writeFile(path.join(args.at(-1),'package-lock.json'),'{}');
    }
    return result;
  };
  return h;
}
const auditReport=(high=0)=>({code:high?1:0,output:JSON.stringify({metadata:{vulnerabilities:{low:0,moderate:0,high,critical:0}},vulnerabilities:high?{unsafe:{severity:'high',via:[{url:'https://github.com/advisories/GHSA-test-test-test',title:'Fixture advisory'}]}}:{}})});
test('remote security gates block before install and recheck the final build before activation',async t=>{
  for(const reports of [[auditReport(1)],[auditReport(),auditReport(1)]]){
    const h=await auditedHarness(t,reports);
    await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Security gate blocked/);
    assert.equal(h.journal.securityStatus,'failed');
    assert.ok(!h.events.some(x=>x[0]==='pm'&&x[1]==='delete'));
    assert.equal((await agent.readJson(path.join(h.root,'apps.json')))[h.job.payload.id].commit,h.prior.commit);
    if(h.events.filter(x=>x[0]==='audit').length===1)assert.ok(!h.events.some(x=>x[1]==='npm ci'));
  }
});
test('remote audits fail closed on invalid reports and expired overrides, and record accepted exceptions',async t=>{
  for(const [report,gate] of [[{code:1,output:'not a report'},null],[auditReport(1),{off:true,until:'2000-01-01',reason:'An expired approval must not work'}]]){
    const h=await auditedHarness(t,[report],gate);
    await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Security/);
  }
  const h=await auditedHarness(t,[auditReport(1)]);
  h.job.payload.auditExceptions=[{projectId:h.job.payload.id,package:'unsafe',advisory:'GHSA-test-test-test',expiresAt:'2099-01-01',reason:'Isolated exception test'}];
  await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
  assert.equal(h.journal.securityStatus,'passed');assert.match(h.journal.log,/EXCEPTION: unsafe/);
});
test('an explicit current one-deployment security override is visible in the release result',async t=>{
  const h=await auditedHarness(t,[auditReport(1)],{off:true,once:true,reason:'Approved for isolated override testing'});
  await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
  assert.equal(h.journal.securityStatus,'overridden');assert.match(h.journal.log,/OVERRIDE:.*administrator/);
});
test('failed activation restores an intentionally stopped application without starting it',async t=>{
  const h=await harness(t,'health'),pm=h.tools.pm;
  h.tools.pm=async args=>args[0]==='jlist'?JSON.stringify([{name:`manager-remote-${h.job.payload.id}`,pm2_env:{status:'stopped'}}]):pm(args);
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Health failed/);
  assert.ok(!h.events.some(x=>x[0]==='pm'&&x[1]==='start'&&x[2]===h.prior.ecosystem));
  assert.match(h.journal.log,/remains stopped/);
});
test('deployment preserves distinct environment files and comments while supplying managed runtime values',async t=>{
  const h=await harness(t);h.job.payload.environmentFiles={'.env':'# base configuration\nVALUE=base\n','.env.local':'# local configuration\nVALUE=local\n'};h.job.payload.managedEnvironment={DATABASE_URL:'postgres://fixture:private@localhost/test'};
  await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
  const release=path.join(h.root,'releases',h.job.payload.id,h.job.id),base=await fs.readFile(path.join(release,'.env'),'utf8'),local=await fs.readFile(path.join(release,'.env.local'),'utf8');
  assert.match(base,/# base configuration\nVALUE=base/);assert.match(local,/# local configuration\nVALUE=local/);assert.ok(!base.includes('VALUE=local'));assert.match(base,/PORT="3100"/);assert.match(local,/DATABASE_URL=/);
  const saved=await agent.readJson(path.join(h.root,'apps.json'));assert.ok(!JSON.stringify(saved).includes('private@localhost'));
});

test('custom deployment scripts replace install and build, pass the branch and stop at the first failure',async t=>{
  for(const failing of [false,true]){
    const h=await harness(t),run=h.dependencies.run,commands=[];h.job.payload.deploy_script='# comment\necho $BRANCH\ncustom-build\nfinal-command';
    h.dependencies.run=async(file,args,options)=>{if(file!=='git'){commands.push(file);assert.equal(options.env.BRANCH,'main');if(failing&&file==='custom-build')throw Error('Custom build failed');}return run(file,args,options);};
    if(failing)await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Custom build failed/);else await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
    assert.deepEqual(commands,[process.platform==='win32'?'echo %BRANCH%':'echo $BRANCH','custom-build',...(failing?[]:['final-command'])]);
    if(failing)assert.ok(!h.events.some(e=>e[0]==='pm'&&e[1]==='delete'));else assert.match(h.journal.log,/\[stage\] security/);
  }
});

test('staging promotion merges only its reviewed commit and pushes only after health and activation are committed',async t=>{
  for(const failure of ['none','merge','push']){
    const h=await harness(t),run=h.dependencies.run;h.job.payload.promotion={stagingId:randomUUID(),sourceCommit:'c'.repeat(40),branch:'staging',mode:'merge'};
    h.dependencies.run=async(file,args,options)=>{
      if(file==='git'&&args.includes('merge')){h.events.push(['merge',args.at(-1)]);if(failure==='merge')throw Error('Merge conflict');}
      if(file==='git'&&args.includes('push')){assert.equal(h.journal.activation.accepted,true);assert.ok(h.events.some(e=>e[0]==='health'&&e[1]==='library.campus.example.edu'));assert.equal(args.at(-1),'HEAD:refs/heads/main');h.events.push(['push']);if(failure==='push')throw Error('Git rejected push');}
      return run(file,args,options);
    };
    if(failure==='merge'){await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Merge conflict/);assert.ok(!h.events.some(e=>e[0]==='pm'&&e[1]==='delete'));}
    else{await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);assert.equal(h.journal.commitSha,h.commit);assert.ok(h.events.some(e=>e[0]==='push'));if(failure==='push')assert.match(h.journal.log,/WARNING: production is live/);}
    assert.ok(h.events.some(e=>e[0]==='merge'&&e[1]==='c'.repeat(40)));
  }
});
test('pre-deploy failure prevents activation and a post-deploy failure leaves the healthy release live',async t=>{
  const h=await harness(t),run=h.dependencies.run;h.job.payload.pre_deploy_cmd='before-build';h.job.payload.post_deploy_cmd='after-deploy';
  h.dependencies.run=async(file,args,options)=>{if(file==='before-build')throw Error('Before build failed');return run(file,args,options)};
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/Before build failed/);assert.ok(!h.events.some(e=>e[0]==='pm'&&e[1]==='delete'));
  h.job.id=randomUUID();h.dependencies.run=async(file,args,options)=>{if(file==='after-deploy')throw Error('After deployment failed');return run(file,args,options)};
  await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);assert.match(h.journal.log,/activated release remains active/);assert.equal(JSON.parse(await fs.readFile(path.join(h.root,'apps.json'),'utf8'))[h.job.payload.id].commit,h.commit);
});

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

for(const failWorker of [false,true])test(`deployment migrates application data and worker release paths${failWorker?' and restores both on worker failure':''}`,async t=>{
  const h=await harness(t),workerId=randomUUID(),stoppedId=randomUUID(),otherId=randomUUID();
  const oldRoot=JSON.parse(await fs.readFile(path.join(h.root,'launch.json'),'utf8')).cwd;
  await fs.mkdir(path.join(oldRoot,'uploads'));await fs.writeFile(path.join(oldRoot,'uploads','user.txt'),'kept');
  const workers={};const processMap=new Map([[`manager-remote-${h.job.payload.id}`,{name:`manager-remote-${h.job.payload.id}`,pm2_env:{status:'online'}}]]);
  for(const [id,running] of [[workerId,true],[stoppedId,false],[otherId,true]]){
    const directory=path.join(h.root,'workers',id);await fs.mkdir(directory,{recursive:true});
    const cwd=id===otherId?h.root:oldRoot,config={command:'node worker.js',workingDirectory:cwd,projectRoot:cwd,projectId:id===otherId?randomUUID():h.job.payload.id,enabled:true};workers[id]=config;
    await agent.atomicJson(path.join(directory,'launch.json'),{command:config.command,cwd,env:{WORKER_SETTING:'old'}});
    await fs.writeFile(path.join(directory,'ecosystem.config.js'),`module.exports=${JSON.stringify({apps:[{name:`manager-worker-${id}`,cwd}]})};`);
    processMap.set(`manager-worker-${id}`,{name:`manager-worker-${id}`,pm2_env:{status:running?'online':'stopped'}});
  }
  await agent.atomicJson(path.join(h.root,'workers.json'),workers);
  h.tools.pm=async args=>{
    h.events.push(['pm',...args]);if(args[0]==='jlist')return JSON.stringify([...processMap.values()]);
    if(args[0]==='delete')processMap.delete(args[1]);
    if(args[0]==='start'){
      if(args[1]===h.prior.ecosystem){processMap.set(`manager-remote-${h.job.payload.id}`,{name:`manager-remote-${h.job.payload.id}`,pm2_env:{status:'online'}});return '';}
      const def=JSON.parse((await fs.readFile(args[1],'utf8')).replace(/^module.exports=/,'').replace(/;\s*$/,''));const p=def.apps[0];
      if(failWorker&&p.name===`manager-worker-${workerId}`&&p.cwd!==oldRoot)throw Error('New worker failed');
      processMap.set(p.name,{name:p.name,pm2_env:{status:'online',pm_cwd:p.cwd}});
    }return '';
  };
  const health=h.dependencies.healthy;h.dependencies.healthy=async app=>{await health(app);if(app.hostname!=='old.campus.example.edu'){const candidate=path.join(h.root,'releases',app.id,h.job.id);assert.equal(await fs.readFile(path.join(candidate,'uploads/user.txt'),'utf8'),'kept');await fs.writeFile(path.join(candidate,'uploads/late.txt'),'late write');}};
  if(failWorker)await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/New worker failed/);
  else await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
  const expected=failWorker?oldRoot:path.join(h.root,'releases',h.job.payload.id,h.job.id);
  assert.equal(await fs.readFile(path.join(expected,'uploads/late.txt'),'utf8'),'late write');
  assert.equal(await fs.realpath(JSON.parse(await fs.readFile(path.join(h.root,'workers',workerId,'launch.json'),'utf8')).cwd),await fs.realpath(expected));
  assert.equal(processMap.get(`manager-worker-${workerId}`).pm2_env.status,'online');assert.ok(!processMap.has(`manager-worker-${stoppedId}`));
  assert.equal(processMap.get(`manager-worker-${otherId}`).pm2_env.status,'online');assert.ok(!h.events.some(e=>e[0]==='pm'&&e[1]==='delete'&&e[2]===`manager-worker-${otherId}`));
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

for(const phase of ['build','health','routing'])test(`deployment cancellation during ${phase} preserves the prior release`,async t=>{
  const h=await harness(t),control=new AbortController(),original={...h.dependencies};
  h.dependencies.signal=control.signal;
  if(phase==='build')h.dependencies.run=async(...args)=>{const result=await original.run(...args);if(args[0]==='npm run build')control.abort();return result};
  if(phase==='health')h.dependencies.healthy=async app=>{await original.healthy(app);if(app.hostname!=='old.campus.example.edu')control.abort()};
  if(phase==='routing')h.dependencies.proxyConfig=async(...args)=>{await original.proxyConfig(...args);if(args[1].includes('https://library.'))control.abort()};
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/cancelled/);
  assert.equal((await agent.readJson(path.join(h.root,'apps.json')))[h.job.payload.id].commit,h.prior.commit);
  if(phase==='build')assert.ok(!h.events.some(e=>e[0]==='pm'&&e[1]==='delete'));
  else assert.ok(h.events.some(e=>e[0]==='pm'&&e[1]==='start'&&e[2]===h.prior.ecosystem));
});

test('cancellation reports recovery failure when the previous release cannot be restored',async t=>{
  const h=await harness(t),control=new AbortController();h.dependencies.signal=control.signal;
  h.dependencies.healthy=async app=>{if(app.hostname==='old.campus.example.edu')throw Error('Previous readiness failed');control.abort()};
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),e=>e.recoveryFailed===true);assert.match(h.journal.log,/rollback failed/);
});

test('manual rollback fetches and verifies the recorded commit before building',async t=>{
  const h=await harness(t),commands=[],original=h.dependencies.run;h.job.payload.commitSha=h.commit;
  h.dependencies.run=async(...args)=>{commands.push(args.slice(0,2));return original(...args)};
  await agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies);
  assert.ok(commands.some(([exe,args])=>exe==='git'&&args.includes('--no-checkout')));
  assert.ok(commands.some(([exe,args])=>exe==='git'&&args.includes('fetch')&&args.at(-1)===h.commit));
  assert.ok(commands.some(([exe,args])=>exe==='git'&&args.includes('--detach')&&args.at(-1)===h.commit));
  assert.match(h.journal.log,/Database contents are not rolled back/);
});
test('a mismatched rollback checkout never reaches installation or activation',async t=>{
  const h=await harness(t);h.job.payload.commitSha='c'.repeat(40);
  await assert.rejects(agent.deploy(h.root,h.job,h.journal,h.tools,h.persist,h.log,h.dependencies),/does not match/);
  assert.ok(!h.events.some(e=>e[0]==='pm'||e[0]==='command'&&e[1]!=='git'));
});
