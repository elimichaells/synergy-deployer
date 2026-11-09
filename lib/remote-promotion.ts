import {ApiError} from '@/lib/api'
import {query} from '@/lib/db'
import {ensureManagedServers,queueRemoteDeploy,uuid} from '@/lib/managed-servers'
import {promotionReview,promotionProblem} from '../scripts/remote-promotion-policy.cjs'

export async function remotePromotionPlan(serverId:string,stagingId:string){
  await ensureManagedServers();uuid(serverId);uuid(stagingId)
  const staging=(await query('select * from remote_apps where server_id=$1 and id=$2',[serverId,stagingId])).rows[0]
  if(!staging)throw new ApiError('Staging application not found on this server',404)
  const production=(await query('select * from remote_apps where server_id=$1 and id=$2',[serverId,staging.production_id])).rows[0]
  if(!production)throw new ApiError('Linked production application not found on this server',404)
  const latest=(await query("select status from remote_jobs where server_id=$1 and app_id=$2 and kind='deploy' order by created_at desc,id desc limit 1",[serverId,stagingId])).rows[0]
  const warnings=['Review the staging changes on your Git server. Database contents and migrations are not reversed by release rollback.']
  if(latest?.status==='failed')warnings.push('The most recent staging deployment failed. Promotion uses the commit staging is still running.')
  return {staging:{id:staging.id,name:staging.name,branch:staging.branch,commit:staging.live_commit},production:{id:production.id,name:production.name,branch:production.branch,commit:production.live_commit,autoDeploy:production.auto_deploy},mode:staging.branch===production.branch?'commit':'merge',review:promotionReview(serverId,staging,production),commits:[],historyKnown:false,databaseFiles:[],blocker:promotionProblem(staging,production),warnings}
}
export async function promoteRemoteApplication(serverId:string,stagingId:string,body:Record<string,unknown>,actor:string){
  const plan=await remotePromotionPlan(serverId,stagingId)
  if(plan.blocker)throw new ApiError(plan.blocker,409)
  if(body.commit!==plan.staging.commit||body.review!==plan.review)throw new ApiError('Staging or production changed. Review the promotion again.',409)
  const job=await queueRemoteDeploy(serverId,plan.production.id,actor,{promotion:{stagingId,commit:plan.staging.commit,review:plan.review}})
  return{deploymentId:job.id,productionId:plan.production.id,status:'queued'}
}
