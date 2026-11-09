import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { ApiError } from './api'
import { db, query } from './db'
import { encryptSecret } from './secret-crypto'
import { ensureManagedServers, serverDetail, uuid } from './managed-servers'
import type { RemoteMetrics } from './managed-server-types'
import { attributeMemory, downsample, evaluateMemory, lowMemoryThreshold, suggestMemoryLimit, type MemorySample } from './server-memory-policy'
import { CAPABILITY } from '@/scripts/manager-agent-resources.cjs'
import { validateHealthProfile } from '../scripts/http-health.cjs'

export async function resourceTransaction<T>(serverId:string, work:(client:PoolClient)=>Promise<T>) {
  await ensureManagedServers();uuid(serverId)
  const client=await db.connect()
  try {await client.query('begin');if(!(await client.query('select id from managed_servers where id=$1 for update',[serverId])).rowCount)throw new ApiError('Server not found',404);const result=await work(client);await client.query('commit');return result}
  catch(error){await client.query('rollback');throw error}finally{client.release()}
}
/** Serializes with deployments, server removal, SSH setup and agent updates. */
export async function admitResource(client:PoolClient,serverId:string,storageChangeId?:string) {
  const server=(await client.query('select * from managed_servers where id=$1 for update',[serverId])).rows[0]
  if(!server?.enabled||!server.last_seen_at||Date.now()-Date.parse(server.last_seen_at)>90000)throw new ApiError('Connect this server before changing its resources',409)
  if(!server.metrics?.capabilities?.includes(CAPABILITY))throw new ApiError('Update this server’s agent in Agent access & updates to enable these controls',409)
  if(!server.metrics?.capabilities?.includes('remote-console-v1'))throw new ApiError('The agent did not advertise its resource job transport; update or reconnect it',409)
  if((await client.query("select 1 from remote_storage_changes where server_id=$1 and status in ('running','needs_review') and ($2::uuid is null or id<>$2)",[serverId,storageChangeId||null])).rowCount)throw new ApiError('Verify the pending database change in Storage before changing this server',409)
  if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running') union all select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted') union all select 1 from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')",[serverId])).rowCount)throw new ApiError('Wait for the current server operation to finish',409)
  if(!(await client.query("select pg_try_advisory_xact_lock(hashtext('manager-ssh-setup'),hashtext($1)) as ok",[serverId])).rows[0].ok)throw new ApiError('Server setup is running',409)
  return server
}
export async function enqueueResource(client:PoolClient,serverId:string,resource:Record<string,unknown>,actor:string|null,target:string|null=null) {
  const allowed=['storage','health','app-logs','disk','memory','start-method','sleep','wake','worker-save','worker-start','worker-stop','worker-restart','worker-delete','worker-logs','cron-run','database-inspect','database-tune','database-review','recovery']
  if(!allowed.includes(String(resource.action)))throw new ApiError('Unknown resource action',400)
  const appId=resource.action==='storage'&&resource.operation==='sync-env'?uuid(resource.serviceId):['health','app-logs','memory','start-method','sleep','wake','database-review','recovery'].includes(String(resource.action))?uuid(resource.id):null
  if(appId&&!(await client.query('select 1 from remote_apps where id=$1 and server_id=$2 and live_commit is not null',[appId,serverId])).rowCount)throw new ApiError('Deploy this application first',409)
  const applicationControl=['health','app-logs'].includes(String(resource.action))||resource.action==='memory'&&resource.restart===false
  if(resource.action==='storage'&&!(await client.query('select metrics from managed_servers where id=$1',[serverId])).rows[0]?.metrics?.capabilities?.includes('storage-control-v1'))throw new ApiError('Update the agent to enable database management on this server',409)
  if(applicationControl&&!(await client.query('select metrics from managed_servers where id=$1',[serverId])).rows[0]?.metrics?.capabilities?.includes('application-control-v1'))throw new ApiError('Update the agent to enable these application controls',409)
  const payload={action:'resource',id:appId,resource,requiredCapability:resource.action==='storage'?'storage-control-v1':applicationControl?'application-control-v1':CAPABILITY,expiresAt:Date.now()+60000}
  if(resource.action==='storage'){
    const provider=(resource.connection as {provider?:string}|undefined)?.provider,driver=provider&&({mysql:'mysql2',mariadb:'mysql2',sqlserver:'mssql',mongodb:'mongodb',redis:'redis'} as Record<string,string>)[provider]
    const targetProvider=(resource.target as {provider?:string}|undefined)?.provider,targetDriver=targetProvider&&({mysql:'mysql2',mariadb:'mysql2',sqlserver:'mssql'} as Record<string,string>)[targetProvider]
    const drivers=[...new Set([driver,...(String(resource.operation).startsWith('migration-')?[targetDriver]:[])].filter(Boolean))] as string[]
    if(drivers.length)resource.driverArchive=await (await import('../scripts/agent-postgres-runtime.cjs')).packagePostgresRuntime(process.cwd(),drivers)
  }
  const job=(await client.query("insert into remote_jobs(server_id,app_id,user_id,kind,operation_type,resource_action,resource_target,payload_ciphertext) values($1,$2,$3,'console','infrastructure',$4,$5,$6) returning id",[serverId,appId,actor,resource.action,target,encryptSecret(JSON.stringify(payload))])).rows[0]
  await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.resource.'+resource.action,serverId,JSON.stringify({jobId:job.id,appId,target})])
  return {jobId:job.id}
}
export async function queueResource(serverId:string,resource:Record<string,unknown>,actor:string,target:string|null=null) {
  return resourceTransaction(serverId,async client=>{await admitResource(client,serverId);return enqueueResource(client,serverId,resource,actor,target)})
}
export async function remoteApplicationHealth(serverId:string,appId:string) {
  const {server,apps}=await serverDetail(serverId),app=apps.find(a=>a.id===uuid(appId))
  if(!app)throw new ApiError('Application not found on this server',404)
  const observation=server.metrics?.apps.find(a=>a.id===appId)
  return {profile:validateHealthProfile({...app.health_profile,path:app.health_path}),stale:server.status!=='online',checkedAt:server.last_seen_at,application:observation?{health:observation.check?.ok?'healthy':observation.status==='stopped'?'stopped':observation.check?'unhealthy':'unknown'}:null}
}
export async function changeRemoteApplicationHealth(serverId:string,appId:string,body:unknown,actor:string) {
  let profile;try{profile=validateHealthProfile(body)}catch(error){throw new ApiError((error as Error).message,400)}
  return resourceTransaction(serverId,async client=>{
    const app=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,uuid(appId)])).rows[0]
    if(!app)throw new ApiError('Application not found on this server',404)
    if(app.live_commit){await admitResource(client,serverId);return enqueueResource(client,serverId,{action:'health',id:appId,profile},actor)}
    if((await client.query("select 1 from remote_jobs where app_id=$1 and status in ('queued','running')",[appId])).rowCount)throw new ApiError('Wait for this application’s current operation before changing readiness settings',409)
    await client.query('update remote_apps set health_profile=$3,health_path=$4 where server_id=$1 and id=$2',[serverId,appId,JSON.stringify(profile),profile.path])
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.health.save',appId,JSON.stringify({serverId})]);return{ok:true,profile}
  })
}
function snapshot(metrics:RemoteMetrics,apps:{id:string;name:string;environment_name?:string|null}[]) {
  const resource=metrics.resources,roots=new Map(metrics.apps.filter(a=>a.pid).map(a=>[a.pid!,`manager-remote-${a.id}`])),memory=attributeMemory(resource?.processes||[],roots)
  return {takenAt:resource?.at||new Date().toISOString(),totalMb:Math.round(metrics.memoryTotal/1048576),availableMb:Math.round(metrics.memoryFree/1048576),commitMb:resource?.commitMb??null,commitLimitMb:resource?.commitLimitMb??null,pageFileMb:resource?.pageFileMb??null,pageFileUsedMb:resource?.pageFileUsedMb??null,
    apps:apps.map(app=>{const name=`manager-remote-${app.id}`,row=memory.apps.find(a=>a.name===name),setting=resource?.apps.find(a=>a.id===app.id);return {name,projectId:app.id,label:app.name,environment:app.environment_name||'production',privateMb:row?.privateMb||0,processes:row?.processes||0,overheadMb:row?.overheadMb||0,limitMb:setting?.limitMb??null}}).sort((a,b)=>b.privateMb-a.privateMb),others:memory.others}
}
export async function recordRemoteMemory(serverId:string,metrics:RemoteMetrics) {
  if(!metrics.resources?.at||metrics.resources.error||!Number.isFinite(Date.parse(metrics.resources.at))||Math.abs(Date.now()-Date.parse(metrics.resources.at))>150000)return
  return resourceTransaction(serverId,async client=>{
    const apps=(await client.query('select id,name,environment_name from remote_apps where server_id=$1 and live_commit is not null',[serverId])).rows,sample=snapshot(metrics,apps)
    if(!(await client.query('insert into remote_memory_samples(server_id,taken_at,sample) values($1,$2,$3) on conflict do nothing',[serverId,sample.takenAt,JSON.stringify(sample)])).rowCount)return
    await client.query("delete from remote_memory_samples where server_id=$1 and taken_at<now()-interval '24 hours'",[serverId])
    const samples=(await client.query('select sample from remote_memory_samples where server_id=$1 order by taken_at',[serverId])).rows.map(r=>r.sample as MemorySample)
    const conditions=evaluateMemory(samples,new Map(sample.apps.filter(a=>a.limitMb).map(a=>[a.name,a.limitMb!])),new Map(sample.apps.map(a=>[a.name,a.label])))
    await client.query('insert into remote_resources(server_id) values($1) on conflict do nothing',[serverId])
    const alerts=(await client.query('select memory_alerts from remote_resources where server_id=$1',[serverId])).rows[0].memory_alerts as {id:string;kind:string;subject:string;last_seen_at:string;resolved_at:string|null}[]
    for(const c of conditions){const existing=alerts.find(a=>!a.resolved_at&&a.kind===c.kind&&a.subject===c.subject);if(existing)Object.assign(existing,c,{last_seen_at:sample.takenAt});else alerts.push({id:randomUUID(),...c,opened_at:sample.takenAt,last_seen_at:sample.takenAt,resolved_at:null,notified:false} as typeof alerts[number])}
    for(const alert of alerts)if(!alert.resolved_at&&Date.parse(sample.takenAt)-Date.parse(alert.last_seen_at)>=900000)alert.resolved_at=sample.takenAt
    await client.query('update remote_resources set memory_alerts=$2 where server_id=$1',[serverId,JSON.stringify(alerts.filter(a=>!a.resolved_at||Date.now()-Date.parse(a.resolved_at)<7*86400000).slice(-500))])
  })
}
export async function remoteMemory(serverId:string) {
  const {server,apps}=await serverDetail(serverId),metrics=server.metrics
  if(!metrics?.resources)throw new ApiError(server.status==='pending'?'Connect this server first':'Update the agent and wait for its first memory sample',409)
  const history=(await query('select sample from remote_memory_samples where server_id=$1 order by taken_at',[serverId])).rows.map(r=>r.sample as ReturnType<typeof snapshot>),sample=metrics.resources.error&&history.length?history[history.length-1]:snapshot(metrics,apps.filter(a=>a.live_commit))
  return {snapshot:{...sample,apps:sample.apps.map(app=>({...app,peakMb:Math.max(app.privateMb,...history.map(s=>s.apps.find(a=>a.name===app.name)?.privateMb||0))}))},history:downsample(history,240),alerts:(await query('select memory_alerts from remote_resources where server_id=$1',[serverId])).rows[0]?.memory_alerts||[],
    stale:!!metrics.resources.error||server.status!=='online'||Date.now()-Date.parse(metrics.resources.at)>150000,notes:[...(metrics.resources.error?[metrics.resources.error]:[]),...(server.platform==='linux'?['Linux process totals use resident memory; shared pages can appear in more than one process.']:[])],thresholds:{lowMemoryMb:lowMemoryThreshold(sample.totalMb),buildMinFreeMb:Math.max(1536,Math.round(sample.totalMb*.1)),buildConcurrency:1},
    startMethods:sample.apps.map(a=>{const s=metrics.resources!.apps.find(s=>s.id===a.projectId);return{projectId:a.projectId,label:a.label,environment:a.environment,state:s?.method==='direct'?'direct':s?.direct?'eligible':'runner',overheadMb:a.overheadMb,reason:s?.reason||null}}),
    staging:sample.apps.filter(a=>a.environment==='staging').map(a=>{const s=metrics.resources!.apps.find(s=>s.id===a.projectId),p=metrics.apps.find(p=>p.id===a.projectId);return{projectId:a.projectId,label:a.label,running:p?.status==='online',privateMb:a.privateMb,sleepAfterMinutes:s?.sleepAfterMinutes??null,sleepingSince:s?.sleepingSince??null,lastActiveAt:s?.lastActiveAt??null}})}
}
export async function remoteApplicationResource(serverId:string,appId:string,kind:string) {
  uuid(appId)
  const {server,apps}=await serverDetail(serverId),app=apps.find(a=>a.id===appId)
  if(!app)throw new ApiError('Application not found on this server',404)
  if(server.status!=='online'||!server.metrics?.resources||server.metrics.resources.error||Date.now()-Date.parse(server.metrics.resources.at)>150000)throw new ApiError('Reconnect this server and wait for a current resource sample',409)
  const settings=server.metrics.resources.apps.find(a=>a.id===appId)
  if(kind==='sleep')return {sleep:{environment:app.environment_name,sleep_after_minutes:settings?.sleepAfterMinutes??null,sleeping_since:settings?.sleepingSince??null,last_active_at:settings?.lastActiveAt??null}}
  const report=await remoteMemory(serverId),row=report.snapshot.apps.find(a=>a.projectId===appId),usageMb=row?.privateMb||0,peakMb=row?.peakMb||0
  return {memory:{running:server.metrics.apps.some(a=>a.id===appId&&a.status==='online'),usageMb,peakMb,processes:row?.processes||0,limitMb:settings?.limitMb??null,serverTotalMb:report.snapshot.totalMb,suggestedMb:suggestMemoryLimit(usageMb,peakMb),alerts:report.alerts.filter((a:{subject:string;resolved_at?:string|null})=>!a.resolved_at&&a.subject===`manager-remote-${appId}`)}}
}
export async function remoteDisk(serverId:string,role:string) {
  const {server}=await serverDetail(serverId),settings=(await query('select cleanup_enabled from remote_resources where server_id=$1',[serverId])).rows[0],jobs=(await query("select id,status,created_at,finished_at,result,log from remote_jobs where server_id=$1 and resource_action='disk' order by created_at desc limit 20",[serverId])).rows
  return{enabled:settings?.cleanup_enabled===true,role,stale:server.status!=='online',capable:server.metrics?.capabilities?.includes(CAPABILITY)===true,volumes:[{path:server.metrics?.resources?.root||'Application disk',locations:[server.metrics?.resources?.root||'Application disk'],free:server.metrics?.diskFree??null,total:server.metrics?.diskTotal??null}],history:jobs.map(j=>({id:j.id,mode:j.result?.mode||'scan',source:j.result?.automatic?'scheduled':'manual',status:['queued','running'].includes(j.status)?'running':j.status,started_at:j.created_at,finished_at:j.finished_at,report:j.result?.report||{warnings:j.status==='failed'?[j.log]:[],progress:'Waiting for the selected agent'}}))}
}
export async function cleanupInput(client:PoolClient,serverId:string,mode:string,automatic=false) {
  const apps=(await client.query('select id,name from remote_apps where server_id=$1',[serverId])).rows,releases=(await client.query("select id,app_id,status,finished_at from remote_jobs where server_id=$1 and kind='deploy' order by created_at desc limit 10000",[serverId])).rows,preview=(await client.query("select result from remote_jobs where server_id=$1 and resource_action='disk' and status='success' order by created_at desc limit 1",[serverId])).rows[0],protectedPaths=(await client.query('select config from remote_automations where server_id=$1',[serverId])).rows.map(r=>r.config.workingDirectory)
  if(mode==='clean'&&!automatic&&preview?.result?.mode!=='scan')throw new ApiError('Scan storage before cleaning expired files',409)
  return {action:'disk',mode,apps,releases,protectedPaths,automatic,reviewToken:preview?.result?.reviewToken}
}
export async function changeDisk(serverId:string,body:Record<string,unknown>,actor:string) {
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId)
    if(body.action==='settings') {if(typeof body.enabled!=='boolean')throw new ApiError('Invalid cleanup setting',400);await client.query('insert into remote_resources(server_id,cleanup_enabled) values($1,$2) on conflict(server_id) do update set cleanup_enabled=$2',[serverId,body.enabled]);await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.cleanup.settings',serverId,JSON.stringify({enabled:body.enabled})]);return{ok:true}}
    if(!['scan','clean'].includes(String(body.action)))throw new ApiError('Unknown cleanup action',400)
    return enqueueResource(client,serverId,await cleanupInput(client,serverId,String(body.action)),actor)
  })
}
