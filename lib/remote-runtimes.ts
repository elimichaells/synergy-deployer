import { ApiError } from './api'
import { query } from './db'
import { ensureManagedServers,uuid } from './managed-servers'
import { REMOTE_SERVICES } from './remote-service-catalog'
import { remoteRuntimeCatalog } from './remote-runtime-catalog'
import {remoteToolUpdate,detectedToolVersion,updateRisk} from './remote-tool-updates'
import {supports as supportsUpgrade} from '../scripts/service-upgrade-policy.cjs'
import type { RemoteMetrics } from './managed-server-types'
const versionChecks=new Map<string,{at:number;latest:string|null;error:string|null}>()
function updateInstructions(service:string,platform:string){
  if(!supportsUpgrade(service,platform))return 'This operating-system or licensed package needs its vendor maintenance workflow. Manager can discover the updated executable and reuse its existing configuration afterward.'
  if(service==='sqlserver')return 'This release updates the sqlcmd client. Plan SQL Server engine upgrades separately.'
  if(service==='phpmyadmin')return 'Review a verified private client replacement. Previous files, settings and sessions are retained; database services and sites stay running.'
  return 'Review this update before applying it. Existing settings and recovery files are retained. Database updates require a maintenance window, a cold backup and authenticated verification.'
}
async function target(id:string){await ensureManagedServers();uuid(id);const row=(await query<{platform:string;metrics:RemoteMetrics}>('select platform,metrics from managed_servers where id=$1',[id])).rows[0];if(!row)throw new ApiError('Server not found',404);return row}
export async function remoteRuntimeVersions(id:string,runtime:string){const server=await target(id);return {runtime,available:(await remoteRuntimeCatalog(runtime,server.platform,server.metrics?.arch||'x64')).map(({asset,...item})=>item),installed:server.metrics?.runtimeVersions?.[runtime]||[]}}
export async function remoteRuntimeJob(id:string,jobId:string){await target(id);uuid(jobId);const o=(await query('select id,service_id,status,plan,result,log,created_at from remote_service_operations where server_id=$1 and id=$2',[id,jobId])).rows[0];if(!o)throw new ApiError('Operation not found on this server',404);return {job:{id:o.id,runtime_id:o.service_id,action:o.plan.selection.mode==='update'?'update':o.plan.selection.mode==='install-version'?'install-version':o.plan.selection.mode==='reuse'?'configure':'install',requested_version:o.plan.selection.version||null,status:o.status,log:o.log,error:o.result?.message||null,created_at:o.created_at}}}
export async function listRemoteRuntimes(id:string,check=false){
  const server=await target(id),operations=(await query('select * from remote_service_operations where server_id=$1 order by created_at desc limit 100',[id])).rows
  return Promise.all(REMOTE_SERVICES.map(async service=>{
    const version=server.metrics?.tools?.[service.tool]||null,versioned=['node','go'].includes(service.id)||service.id==='php'&&server.platform==='win32'
    const current=detectedToolVersion(service.id,version||''),key=[service.id,server.platform,server.metrics?.arch,current].join(':')
    let tool=await remoteToolUpdate(service.id,server.platform,version,check&&!versioned)
    if(versioned){
      if(check){if(versionChecks.size>=1000)versionChecks.delete(versionChecks.keys().next().value!);try{versionChecks.set(key,{at:Date.now(),latest:(await remoteRuntimeCatalog(service.id,server.platform,server.metrics?.arch||'x64'))[0]?.version||null,error:null})}catch(error){versionChecks.set(key,{at:Date.now(),latest:null,error:(error as Error).message})}}
      const saved=versionChecks.get(key),recent=saved&&Date.now()-saved.at<3600000?saved:null
      tool={latestVersion:recent?.latest||null,updateCheckSupported:true,updateCheckedAt:recent&&!recent.error?new Date(recent.at).toISOString():null,updateCheckError:recent?.error||null,updateSourceUrl:service.id==='node'?'https://nodejs.org/en/download':service.id==='go'?'https://go.dev/dl/':'https://windows.php.net/download/'}
    }
    const latest=tool.latestVersion,updates=!!latest&&!!current&&latest.localeCompare(current,undefined,{numeric:true})>0
    const job=(o:typeof operations[number]|undefined)=>o?{id:o.id,runtime_id:o.service_id,action:o.plan.selection.mode==='update'?'update':o.plan.selection.mode==='install-version'?'install-version':o.plan.selection.mode==='reuse'?'configure':'install',requested_version:o.plan.selection.version||null,status:o.status,log:o.log,error:o.result?.message||null,created_at:o.created_at}:null
    const own=operations.filter(o=>o.service_id===service.id),installSupported=(service.id!=='sqlserver'||server.platform==='win32')&&(service.id!=='redis'||server.platform==='linux')
    return {id:service.id,name:service.name,purpose:'Deployment dependency on this server',installed:!!version,version,canInstall:installSupported,canUpdate:versioned?!server.metrics?.runtimeVersions?.[service.id]?.includes(latest||''):supportsUpgrade(service.id,server.platform),updateMode:versioned?'project-version':'maintenance',canConfigure:service.id!=='phpmyadmin',canReuse:service.id!=='phpmyadmin',versioned,installedVersions:server.metrics?.runtimeVersions?.[service.id]||[],updateAvailable:updates,latestVersion:latest,updateRisk:updates?service.id==='postgresql'&&current!.split('.')[0]===latest!.split('.')[0]?'patch':updateRisk(current!,latest!):null,updateCheckedAt:tool.updateCheckedAt,updateCheckSupported:tool.updateCheckSupported,updateCheckError:tool.updateCheckError,updateSourceUrl:tool.updateSourceUrl,updateInstructions:updates&&!versioned?updateInstructions(service.id,server.platform):null,activeJob:job(own.find(o=>['running','interrupted'].includes(o.status))),latestJob:job(own[0]),installSource:service.id==='redis'&&server.platform==='win32'?'Reuse a production-licensed Memurai installation or connect an existing Redis server in Storage.':installSupported?'Selected remote server · reviewed SSH installation; existing sites and service defaults preserved':'Reuse an existing SQL Server client and connect its database in Storage. Automatic Express installation requires Windows x64.'}
  }))
}
