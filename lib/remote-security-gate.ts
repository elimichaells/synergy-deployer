import { ApiError } from './api'
import { query } from './db'
import { ensureManagedServers, uuid, queueRemoteDeploy } from './managed-servers'
import { resourceTransaction } from './remote-resources'
import { gateOffUntil, validateGateOverride } from './security-gate-policy'
import { remoteGateState } from './remote-security-gate-policy'
export async function readRemoteGate(serverId:string,appId:string) {
  await ensureManagedServers()
  const app=(await query('select security_gate from remote_apps where server_id=$1 and id=$2',[uuid(serverId),uuid(appId)])).rows[0]
  if(!app)throw new ApiError('Application not found on this server',404)
  return remoteGateState(app.security_gate)
}
export async function remoteOverridePlan(serverId:string,jobId:string) {
  await ensureManagedServers()
  const row=(await query(`select j.*,a.name,a.branch as current_branch,not exists(select 1 from remote_jobs n where n.app_id=j.app_id and n.kind='deploy' and n.created_at>j.created_at) as newest from remote_jobs j join remote_apps a on a.id=j.app_id where j.server_id=$1 and j.id=$2 and j.kind='deploy'`,[uuid(serverId),uuid(jobId)])).rows[0]
  if(!row)throw new ApiError('Deployment not found on this server',404)
  return{projectId:row.app_id,projectName:row.name,branch:row.current_branch,kind:'deploy',staging:null,blocker:row.status!=='failed'||row.security_status!=='failed'?'This deployment was not stopped by the security gate.':!row.newest?'A newer deployment exists. Open that deployment instead.':null}
}
export async function overrideRemoteDeployment(serverId:string,jobId:string,body:Record<string,unknown>,actor:string) {
  let override;try{override=validateGateOverride(body)}catch(error){throw new ApiError((error as Error).message,400)}
  const plan=await remoteOverridePlan(serverId,jobId);if(plan.blocker)throw new ApiError(plan.blocker,409)
  const job=await queueRemoteDeploy(serverId,plan.projectId,actor,{override:{jobId,...override}})
  return{deploymentId:job.id,gate:await readRemoteGate(serverId,plan.projectId)}
}
export async function changeRemoteGate(serverId:string,appId:string,body:Record<string,unknown>,actor:{id:string;role:string;name?:string}) {
  let setting=null
  if(body.enforce!==true){
    if(actor.role!=='admin')throw new ApiError('Only administrators may turn off the security gate',403)
    let override;try{override=validateGateOverride(body)}catch(error){throw new ApiError((error as Error).message,400)}
    if(override.scope==='once')throw new ApiError('Choose how long the application gate stays off',400)
    setting={until:gateOffUntil(override.scope),reason:override.reason,by:actor.name||null,userId:actor.id,at:new Date().toISOString()}
  }
  return resourceTransaction(serverId,async client=>{
    if(!(await client.query('update remote_apps set security_gate=$3 where server_id=$1 and id=$2 returning id',[serverId,uuid(appId),setting?JSON.stringify(setting):null])).rowCount)throw new ApiError('Application not found on this server',404)
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor.id,setting?'remote.security_gate.turned_off':'remote.security_gate.turned_on',appId,JSON.stringify({serverId,...setting})])
    return{gate:remoteGateState(setting)}
  })
}
