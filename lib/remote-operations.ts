import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from './api'
import { query } from './db'
import { aiHistory, aiSettings, ensureAiSchema, saveAiSettings } from './ai-operations-store'
import { diagnoseWithAi } from './ai-operations-provider'
import { assertReviewTicket, localDiagnosis, recoveryBlockers } from './ai-operations-policy'
import { serverDetail, uuid } from './managed-servers'
import { remoteHealth } from './remote-health'
import { admitResource, enqueueResource, queueResource, resourceTransaction } from './remote-resources'
import { summarizeUptime } from '@/scripts/uptime-history.cjs'
import type { ServerHealth } from './server-health-types'
const nameOf=(a:{name:string;id:string;environment_name?:string|null})=>`${a.name} · ${a.environment_name||'production'} · ${a.id.slice(0,8)}`
export async function remoteOperations(serverId:string,range:string,role:string) {
  const {apps}=await serverDetail(serverId);await ensureAiSchema()
  if(!['24h','7d','30d'].includes(range))throw new ApiError('Invalid uptime range',400)
  const health=await remoteHealth(serverId) as ServerHealth,row=(await query('select uptime from remote_resources where server_id=$1',[serverId])).rows[0]
  return {diagnosis:localDiagnosis(health),settings:await aiSettings(serverId),role,checkedAt:health.checkedAt,stale:health.stale,mapping:apps.filter(a=>a.live_commit).map((a,i)=>({service:`service-${i+1}`,name:nameOf(a)})),apps:apps.filter(a=>a.live_commit).map(a=>({id:a.id,name:a.name,pm2_name:nameOf(a)})),uptime:{...summarizeUptime(row?.uptime,range),unavailable:!row?.uptime,stale:health.stale},history:await aiHistory(serverId)}
}
async function recoveryContext(serverId:string,appId:string) {
  const {server,apps}=await serverDetail(serverId),app=apps.find(a=>a.id===appId)
  if(!app?.live_commit)throw new ApiError('Deployed application not found',404)
  const health=await remoteHealth(serverId) as ServerHealth,blockers=recoveryBlockers(health,nameOf(app),false),process=server.metrics?.apps.find(a=>a.id===appId)
  if(!(await aiSettings(serverId)).recoveryEnabled)blockers.push('Reviewed recovery is paused by an administrator.')
  if(!process?.pid)blockers.push('The current private process identity is unavailable.')
  if((await query("select 1 from manager_ai_events where server_id=$1 and project_id=$2 and kind='recovery' and (created_at>now()-interval '30 minutes' or status='failed') limit 1",[serverId,appId])).rowCount)blockers.push('Review the previous recovery result; attempts require a 30-minute cooldown and failed attempts must be acknowledged.')
  if(blockers.length)throw new ApiError(blockers.join(' '),409)
  const identity={id:app.id,pid:process!.pid,restarts:process!.restarts,commit:app.live_commit,port:app.port,health_path:app.health_path}
  const fingerprint=createHash('sha256').update(JSON.stringify({identity,incidents:health.incidents.filter(i=>!i.resolvedAt&&i.service===nameOf(app)).map(i=>i.id).sort()})).digest('hex')
  return {app,identity,fingerprint}
}
export async function changeOperations(serverId:string,body:Record<string,unknown>,actor:string,role:string) {
  await serverDetail(serverId);await ensureAiSchema()
  if(body.action==='database')return queueResource(serverId,{action:'database-review',id:uuid(body.projectId)},actor)
  return resourceTransaction(serverId,async client=>{
    if(body.action==='settings'){if(role!=='admin')throw new ApiError('Administrator access required',403);return{settings:await saveAiSettings(body,serverId)}}
    if(body.action==='diagnose')return{diagnosis:await diagnoseWithAi(await remoteHealth(serverId) as ServerHealth,actor,serverId)}
    if(body.action==='acknowledge'){await client.query("update manager_ai_events set status='acknowledged' where id=$1 and server_id=$2 and kind='recovery' and status='failed'",[uuid(body.eventId),serverId]);return{ok:true}}
    if(body.action==='cancel-recovery'){await client.query("update remote_recovery_reviews set status='cancelled' where id=$1 and server_id=$2 and actor_id=$3 and status='pending'",[uuid(body.reviewId),serverId,actor]);return{cancelled:true}}
    await admitResource(client,serverId)
    if(body.action==='prepare-recovery') {
      const c=await recoveryContext(serverId,uuid(body.projectId)),id=randomUUID(),expiresAt=new Date(Date.now()+300000).toISOString()
      await client.query('insert into remote_recovery_reviews(id,server_id,app_id,actor_id,fingerprint,expires_at) values($1,$2,$3,$4,$5,$6)',[id,serverId,c.app.id,actor,c.fingerprint,expiresAt])
      return {review:{id,projectName:c.app.name,expiresAt,action:'Restart this application once on the selected server',impact:'Only this private application process is restarted. Requests may fail briefly.',verification:'The agent rechecks process identity and readiness, then requires two passing checks and verifies that other private processes were unchanged.',rollback:'No configuration or release changes. If readiness fails, recovery stops for investigation and cannot repeat until reviewed.'}}
    }
    if(body.action==='execute-recovery') {
      if(body.confirm!==true)throw new ApiError('Confirm the app-specific recovery review',400)
      const review=(await client.query('select * from remote_recovery_reviews where id=$1 and server_id=$2 for update',[uuid(body.reviewId),serverId])).rows[0]
      if(!review)throw new ApiError('Review not found',404)
      const c=await recoveryContext(serverId,review.app_id)
      try{assertReviewTicket(review,actor,c.fingerprint)}catch(error){throw new ApiError((error as Error).message,409)}
      const job=await enqueueResource(client,serverId,{action:'recovery',...c.identity},actor,c.app.id)
      await client.query("update remote_recovery_reviews set status='executing',job_id=$2 where id=$1",[review.id,job.jobId])
      await client.query("insert into manager_ai_events(id,kind,actor_id,project_id,server_id,status,details) values($1,'recovery',$2,$3,$4,'running',$5)",[job.jobId,actor,c.app.id,serverId,JSON.stringify({message:'Reviewed recovery queued on selected server',service:c.app.name})])
      return job
    }
    throw new ApiError('Unknown operations action',400)
  })
}
