'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const upgrade=require('../scripts/service-upgrade.cjs'),runner=require('../scripts/service-upgrade-runner.cjs'),load=require('./server-module.cjs');
require('./fixtures/vendor-catalog-auth.cjs');
test('verified tool upgrades retain previous installations and unrelated settings',{skip:process.env.MANAGER_SERVICE_UPGRADE_NATIVE!=='1',timeout:900000},async t=>{
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const windows=process.platform==='win32',base=await fs.realpath(windows?process.env.ProgramData:os.tmpdir()),root=await fs.mkdtemp(path.join(base,'manager-tool-upgrades-')),agentRoot=path.join(root,'agent'),dataRoot=path.join(root,'updates');await fs.mkdir(agentRoot);await fs.mkdir(dataRoot);
  t.after(async()=>{assert.equal(path.dirname(root),base);assert.match(path.basename(root),/^manager-tool-upgrades-/);await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:300})});
  const php=await fs.realpath((await upgrade.run(windows?'where.exe':'which',['php'])).trim().split(/\r?\n/)[0]),paths={node:process.execPath,php};await upgrade.atomic(path.join(agentRoot,'tool-paths.json'),paths);await fs.writeFile(path.join(root,'site-settings'),'preserved unrelated site');
  if(windows){await upgrade.run('icacls.exe',[root,'/grant','*S-1-5-19:(OI)(CI)RX']);await upgrade.run('icacls.exe',[agentRoot,'/grant','*S-1-5-19:(OI)(CI)M']);}
  const downloads=load('lib/service-upgrade-downloads.ts',{'./api':{ApiError:Error},'./server-ssh':{installerDownloads:async()=>({node:{}})}});
  for(const [service,currentVersion,version]of [['composer','2.11.1','2.11.2'],['sling','1.6.6','1.6.7'],['sqlserver','1.9.0','1.10.0'],['angular','21.2.28','21.2.29'],...(windows?[['git','2.56.0','2.56.1']]:[])]){
    console.log('Testing '+service+' '+currentVersion+' -> '+version);
    const oldRoot=path.join(root,'original-'+service),assets=await downloads.serviceUpgradeDownloads(service,'0.0.0',currentVersion,process.platform,process.arch);let executable;
    if(service==='angular'){const npm=path.join(path.dirname(process.execPath),windows?'node_modules/npm/bin/npm-cli.js':'../lib/node_modules/npm/bin/npm-cli.js');await upgrade.run(process.execPath,[npm,'install','--prefix',oldRoot,'--ignore-scripts','--no-audit','--no-fund','@angular/cli@'+currentVersion],{timeout:180000});executable=path.join(oldRoot,'node_modules/.bin',windows?'ng.cmd':'ng');}
    else{const unpacked=await upgrade.unpack(assets.update,oldRoot);executable=path.join(unpacked,assets.update.executable)}
    assert.equal(await runner.binaryVersion(service,executable,{php}),currentVersion);
    if(service==='git'){paths.git=executable;await upgrade.atomic(path.join(agentRoot,'tool-paths.json'),paths);await fs.writeFile(path.join(oldRoot,'content','git-bash.exe'),'unrelated full-installation sentinel');await fs.mkdir(path.join(oldRoot,'content','etc'),{recursive:true});await fs.appendFile(path.join(oldRoot,'content','etc','gitconfig'),'\n[managerFixture]\n preserve = true\n');}
    const plan={service,mode:'update',operationId:randomUUID(),currentVersion,version,path:executable,agentRoot,dataRoot,downloads:await downloads.serviceUpgradeDownloads(service,currentVersion,version,process.platform,process.arch)},result=await runner.execute(plan,root);
    if(service==='git'){assert.equal(await runner.binaryVersion(service,executable),currentVersion,'the original installation is never overwritten');assert.equal(JSON.parse(await fs.readFile(path.join(agentRoot,'tool-paths.json'))).git,result.path);assert.equal((await upgrade.run(result.path,['config','--system','--get','managerFixture.preserve'])).trim(),'true');const repo=path.join(root,'new-git-repository');await upgrade.run(result.path,['init','--bare',repo]);assert.equal((await upgrade.run(result.path,['-C',repo,'rev-parse','--is-bare-repository'])).trim(),'true');assert.equal(await fs.readFile(path.join(oldRoot,'content','git-bash.exe'),'utf8'),'unrelated full-installation sentinel');}
    assert.equal(result.status,'success',service);assert.equal(await runner.binaryVersion(service,result.path,{php}),version);assert.equal(await fs.readFile(path.join(root,'site-settings'),'utf8'),'preserved unrelated site');await runner.recover(plan,root,'restore');assert.equal(await runner.binaryVersion(service,executable,{php}),currentVersion);console.log(service+' upgrade and restoration verified');
    if(service==='git')assert.equal(JSON.parse(await fs.readFile(path.join(agentRoot,'tool-paths.json'))).git,executable);
  }
});
