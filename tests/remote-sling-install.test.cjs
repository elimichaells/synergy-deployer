'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const load=require('./server-module.cjs'),agent=require('../scripts/manager-agent.cjs'),policy=require('../scripts/remote-service-policy.cjs');
test('Sling custom paths and existing binaries are reused through the shared runtime catalog',()=>{
  const tools=load('lib/server-tool-catalog.ts',{}),discovery=load('lib/server-discovery.ts',{'./server-tool-catalog':tools});
  assert.ok(tools.SERVER_TOOLS.some(t=>t.id==='sling'));assert.equal(discovery.toolCompatible('sling','Version: 1.5.23'),true);assert.equal(discovery.toolCompatible('sling','unrelated 1.5.23'),false);
  for(const platform of ['win32','linux']){
    const executable=platform==='win32'?'D:\\Institution Tools\\sling.exe':'/srv/institution tools/sling',inventory={platform,portsKnown:true,ports:[],services:[],tools:{sling:[{path:executable,compatible:true}]}};
    policy.verifyServicePlan(policy.servicePlan({service:'sling',mode:'reuse',path:executable},platform),inventory);
    assert.throws(()=>policy.verifyServicePlan(policy.servicePlan({service:'sling',mode:'install'},platform),inventory),/existing installation/);
  }
});
test('official Sling install verifies its archive and preserves an existing executable',{skip:process.env.MANAGER_RUNTIME_INSTALL_LAB!=='1',timeout:180000},async t=>{
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'manager-sling-install-'));t.after(async()=>{assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});});
  class ApiError extends Error{}
  const downloads=load('lib/remote-service-downloads.ts',{'./api':{ApiError},'./server-ssh':{installerDownloads:async()=>({node:{}})}}),plan=path.join(root,'plan.json'),target=path.join(root,'custom tools');await fs.mkdir(target);
  await fs.writeFile(plan,JSON.stringify({service:'sling',mode:'install',downloads:await downloads.serviceDownloads('sling',process.platform,process.arch)}));
  const run=()=>agent.run(process.execPath,['scripts/install-remote-tool.cjs',plan,target],{timeout:150000});await run();
  const executable=path.join(target,process.platform==='win32'?'sling.exe':'sling'),bytes=await fs.readFile(executable),before=createHash('sha256').update(bytes).digest('hex');
  assert.match(await agent.run(executable,['--version'],{timeout:15000,env:{...process.env,AWS_EC2_METADATA_DISABLED:'true'}}),/1\.5\.23/);
  await assert.rejects(run(),/already exists/);assert.equal(createHash('sha256').update(await fs.readFile(executable)).digest('hex'),before);
  assert.equal(await fs.readFile(path.join(target,'executable.txt'),'utf8'),executable);
});
