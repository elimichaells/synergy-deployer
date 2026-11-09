import { ApiError } from './api'
import { parseLanAddress } from '../scripts/lan-address.cjs'
import { audit } from './audit'
import { db,query } from './db'
import { ensureManagedServers,serverDetail,uuid } from './managed-servers'
import { encryptSecret } from './secret-crypto'
import { INFRASTRUCTURE_CAPABILITY, LAN_CAPABILITY, validateLanSelection } from '@/scripts/manager-agent.cjs'

export async function remoteProcesses(serverId:string) {
  const {server,apps}=await serverDetail(serverId)
  return apps.map(app=>{const p=server.metrics?.apps.find(p=>p.id===app.id);return {controlReason:server.status!=='online'?'Connect this server first':!server.metrics?.capabilities?.includes(INFRASTRUCTURE_CAPABILITY)?'Update the agent to enable process controls':!app.live_commit?'Deploy this application first':null,id:app.id,name:`manager-remote-${app.id}`,displayName:app.name,status:server.status==='online'?p?.status||'unknown':'unknown',uptime:p?.uptime||null,cpu:p?.cpu||0,memory:Math.round((p?.memory||0)/1024/1024),restarts:p?.restarts??0,url:app.hostname?`https://${app.hostname}`:null,port:app.port}})
}
export async function remoteInfrastructureJob(serverId:string,jobId:string,admin:boolean) {
  await ensureManagedServers();uuid(serverId);uuid(jobId)
  const job=(await query("select id,app_id,status,log,result,resource_action from remote_jobs where server_id=$1 and id=$2 and operation_type='infrastructure'",[serverId,jobId])).rows[0]
  if(!job||!admin&&!job.app_id&&!['worker-save','worker-start','worker-stop','worker-restart','worker-delete','worker-logs','cron-run','database-inspect'].includes(job.resource_action))throw new ApiError('Operation not found',404)
  if(job.resource_action==='database-inspect'&&job.result)job.result=(await import('./remote-databases')).decorateDatabaseResult(job.result,admin)
  return {job}
}
export async function queueInfrastructure(serverId:string,appId:string|null,action:unknown,userId:string,domain?:{id:string;hostname:string;remove:boolean;restoreHostname?:string;restoreAccessMode?:string}) {
  await ensureManagedServers();uuid(serverId);if(appId)uuid(appId)
  if(typeof action!=='string'||!(appId?['start','stop','restart','domain']:['start','stop','restart','reload','validate','read-config']).includes(action))throw new ApiError('Unknown operation',400)
  const client=await db.connect();let id:string
  try {
    await client.query('begin')
    const server=(await client.query('select * from managed_servers where id=$1 for update',[serverId])).rows[0]
    if(!server?.enabled||!server.last_seen_at||Date.now()-Date.parse(server.last_seen_at)>90000)throw new ApiError('Connect this server before controlling processes',409)
    if(!server.metrics?.capabilities?.includes(INFRASTRUCTURE_CAPABILITY))throw new ApiError('Update this server’s agent to enable infrastructure controls',409)
    if(appId&&!(await client.query('select 1 from remote_apps where server_id=$1 and id=$2 and live_commit is not null',[serverId,appId])).rowCount)throw new ApiError('Deploy this application before controlling its process',409)
    if(!appId&&server.metrics.caddy?.mode==='shared'&&['start','stop','restart'].includes(action))throw new ApiError('Shared Caddy serves existing sites. Use Reload Config to update only managed routes.',409)
    if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running') union all select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted') union all select 1 from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')",[serverId])).rowCount)throw new ApiError('Wait for the current server operation to finish',409)
    if(domain)try{validateLanSelection(domain.hostname,server.metrics)}catch(error){throw new ApiError((error as Error).message,409)}
    const payload={id:appId,action,domain,expiresAt:Date.now()+60000,requiredCapability:parseLanAddress(domain?.hostname)?LAN_CAPABILITY:INFRASTRUCTURE_CAPABILITY}
    id=(await client.query("insert into remote_jobs(server_id,app_id,user_id,kind,operation_type,payload_ciphertext) values($1,$2,$3,'console','infrastructure',$4) returning id",[serverId,appId,userId,encryptSecret(JSON.stringify(payload))])).rows[0].id
    await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
  await audit(userId,'remote.infrastructure.'+action,appId||serverId,{serverId,jobId:id})
  return {jobId:id,message:'Operation queued on the selected server.'}
}
