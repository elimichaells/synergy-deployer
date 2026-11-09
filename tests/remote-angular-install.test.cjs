'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const load=require('./server-module.cjs'),agent=require('../scripts/manager-agent.cjs'),policy=require('../scripts/remote-service-policy.cjs');
test('Angular custom paths and existing CLIs use the shared runtime catalog',()=>{
  const tools=load('lib/server-tool-catalog.ts',{}),discovery=load('lib/server-discovery.ts',{'./server-tool-catalog':tools});
  assert.ok(tools.SERVER_TOOLS.some(t=>t.id==='ng'));assert.equal(discovery.toolCompatible('ng','Angular CLI: 21.2.29'),true);assert.equal(discovery.toolCompatible('ng','unrelated 21.2.29'),false);
  for(const platform of ['win32','linux']){const executable=platform==='win32'?'D:\\Institution Tools\\ng.cmd':'/srv/institution tools/ng',inventory={platform,portsKnown:true,ports:[],services:[],tools:{ng:[{path:executable,compatible:true}]}};policy.verifyServicePlan(policy.servicePlan({service:'angular',mode:'reuse',path:executable},platform),inventory);assert.throws(()=>policy.verifyServicePlan(policy.servicePlan({service:'angular',mode:'install'},platform),inventory),/existing installation/);}
});
test('isolated Angular installation runs through selected Node and refuses replacement',{skip:process.env.MANAGER_RUNTIME_INSTALL_LAB!=='1',timeout:240000},async t=>{
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'manager-angular-install-'));t.after(async()=>{assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});});
  class ApiError extends Error{}
  const downloads=load('lib/remote-service-downloads.ts',{'./api':{ApiError},'./server-ssh':{installerDownloads:async()=>({node:{}})}}),plan=path.join(root,'plan.json'),target=path.join(root,'custom tools');await fs.mkdir(target);
  await fs.writeFile(plan,JSON.stringify({service:'angular',mode:'install',downloads:await downloads.serviceDownloads('angular',process.platform,process.arch)}));
  const run=()=>agent.run(process.execPath,['scripts/install-remote-tool.cjs',plan,target],{timeout:180000});await run();
  const executable=await fs.readFile(path.join(target,'executable.txt'),'utf8');assert.ok(executable.startsWith(target+path.sep));
  const direct=await agent.run(process.execPath,[path.join(target,'node_modules/@angular/cli/bin/ng.js'),'version'],{cwd:root,timeout:20000,env:{...process.env,NG_CLI_ANALYTICS:'false',FORCE_COLOR:'0'}});assert.match(direct,/Angular CLI\s*:\s*21\.2\.29/);
  await agent.atomicJson(path.join(root,'tool-paths.json'),{node:process.execPath,ng:executable});await agent.loadToolPaths(root);assert.equal(await agent.toolVersion('ng'),'Angular CLI: 21.2.29');
  const metadata=path.join(target,'node_modules/@angular/cli/package.json'),before=await fs.readFile(metadata,'utf8');await assert.rejects(run(),/already exists/);assert.equal(await fs.readFile(metadata,'utf8'),before);
});
