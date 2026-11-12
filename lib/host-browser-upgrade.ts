import path from 'node:path'
import {readFile,mkdir,access} from 'node:fs/promises'
import {randomUUID,createHmac} from 'node:crypto'
import {toolsRoot,webRoot} from './paths'
import {serviceUpgradeDownloads} from './service-upgrade-downloads'
import {runCommand} from './exec'
import {atomic,browserPrepare,browserActivate,browserRecover,run} from '../scripts/service-upgrade.cjs'
import {configure} from '../scripts/install-database-browser.cjs'

// Host and remote upgrades use the same complete-release staging, vendor
// checksum, configuration/session preservation and durable marker transaction.
export async function upgradeHostBrowser(version:string,log:(value:string)=>Promise<void>){
  const state=path.join(toolsRoot(),'phpmyadmin-state');await mkdir(state,{recursive:true})
  const marker=path.join(state,'database-browser.json');let previous:any
  try{previous=JSON.parse(await readFile(marker,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
    const php=process.env.PHPMYADMIN_PHP||(await run('where.exe',['php.exe'])).trim().split(/\r?\n/)[0],phpCgi=path.join(path.dirname(php),'php-cgi.exe');await access(phpCgi)
    const clientRoot=process.env.PHPMYADMIN_ROOT||path.join(toolsRoot(),'phpmyadmin'),current=(await readFile(path.join(clientRoot,'VERSION'),'utf8')).trim()
    if(!process.env.JWT_SECRET)throw new Error('The Manager browser secret is unavailable')
    const privateConfig=await configure(state,phpCgi,current)
    previous={version:current,clientRoot,phpCgi,phpIni:privateConfig.phpIni,tempRoot:path.join(webRoot(),'temp/phpmyadmin'),sessionRoot:path.join(webRoot(),'temp/phpmyadmin-sessions'),secret:createHmac('sha256',process.env.JWT_SECRET).update('manager:phpmyadmin').digest('hex')}
    await atomic(marker,previous)
  }
  const downloads=await serviceUpgradeDownloads('phpmyadmin',previous.version,version,process.platform,process.arch),operationId=randomUUID(),target=path.join(state,'releases',operationId);await mkdir(path.dirname(target),{recursive:true})
  const plan={service:'phpmyadmin',mode:'update',version,currentVersion:previous.version,agentRoot:state,operationId,downloads}
  await log('[update] Staging and verifying the private phpMyAdmin release. Existing files and PHP settings are retained.\n');await browserPrepare(plan,target)
  const check=async(root:string)=>{await run(process.execPath,[path.join(process.cwd(),'scripts/database-browser-agent.cjs'),root])}
  const restart=async()=>{const result=await runCommand('pm2 restart "manager-phpmyadmin" --update-env',process.cwd(),60000,undefined,{MANAGER_ROOT:process.cwd()},false);if(result.code!==0)throw new Error('The private browser process did not restart');for(let attempt=0;attempt<30;attempt++){try{const response=await fetch(`http://127.0.0.1:${process.env.PHPMYADMIN_PORT||8433}/`,{redirect:'manual',signal:AbortSignal.timeout(2000)});if(response.status===200&&(await response.text()).includes('name="pma_username"'))return}catch{}await new Promise(resolve=>setTimeout(resolve,500))}throw new Error('The updated private browser did not pass its login-page check')}
  await browserActivate(plan,target,check)
  try{await restart();await log('[verify] phpMyAdmin '+version+' is ready. Previous release, sessions, database services and proxy routes preserved.\n')}
  catch(error){await browserRecover(plan,target,check);await restart();throw error}
}
