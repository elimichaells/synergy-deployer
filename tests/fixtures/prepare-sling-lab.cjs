'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),load=require('../server-module.cjs'),agent=require('../../scripts/manager-agent.cjs');
(async()=>{
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Use only a disposable GitHub-hosted runner');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-sling-lab-')),plan=path.join(root,'plan.json');
  const downloads=load('lib/remote-service-downloads.ts',{'./api':{ApiError:Error},'./server-ssh':{installerDownloads:async()=>({node:{}})}});
  await fs.writeFile(plan,JSON.stringify({service:'sling',mode:'install',downloads:await downloads.serviceDownloads('sling',process.platform,process.arch)}));
  await agent.run(process.execPath,['scripts/install-remote-tool.cjs',plan,root],{timeout:180000});
  await fs.appendFile(process.env.GITHUB_ENV,'TEST_SLING='+path.join(root,process.platform==='win32'?'sling.exe':'sling')+'\n');
})().catch(error=>{console.error(error.message);process.exitCode=1});
