import { randomBytes,createHash } from 'node:crypto'
import { ApiError } from '@/lib/api'
import { db,query } from '@/lib/db'
import { ensureManagedServers,queueRemoteDeploy,uuid } from '@/lib/managed-servers'
import { decryptSecret,encryptSecret } from '@/lib/secret-crypto'
import { getGitConnection,getGitHubConnectionToken } from '@/lib/github-connections'
import { gitApi } from '@/lib/git-provider-api'
import { repositoryPath,repositoryUrl } from '@/lib/git-provider-policy'
import { managerUrl } from '@/lib/manager-address'
import { remotePush } from '@/lib/remote-webhook-policy'

export const remoteWebhookUrl=(server:string,app:string)=>`${managerUrl()}/api/webhooks/remote/${server}/${app}`
async function context(serverId:string,appId:string){
  await ensureManagedServers()
  const app=(await query('select * from remote_apps where server_id=$1 and id=$2',[uuid(serverId),uuid(appId)])).rows[0]
  if(!app)throw new ApiError('Application not found on this server',404)
  const host=await getGitConnection(app.git_connection_id),repository=repositoryPath(app.repo_url,host)
  return{app,host,repository,url:remoteWebhookUrl(serverId,appId)}
}
async function hookContext(serverId:string,appId:string){
  const ctx=await context(serverId,appId),token=await getGitHubConnectionToken(ctx.app.git_connection_id),endpoint=ctx.host.provider==='gitlab'?`/projects/${encodeURIComponent(ctx.repository)}/hooks`:`/repos/${ctx.repository}/hooks`
  let existing:any=null
  for(let page=1;page<=20;page++){
    const response=await gitApi(ctx.host,token,endpoint+`?page=${page}&per_page=100&limit=100`)
    if(!response.ok||!Array.isArray(response.data))throw new ApiError(`Cannot read repository webhooks (HTTP ${response.status}). The Git connection needs webhook administration access.`,409)
    existing=response.data.find(hook=>(hook.config?.url||hook.url)===ctx.url)
    if(existing||response.data.length<100)break
    if(page===20)throw new ApiError('Too many repository webhooks to inspect safely',409)
  }
  return{...ctx,token,endpoint,existing}
}
export async function remoteGitStatus(serverId:string,appId:string){
  const ctx=await context(serverId,appId)
  let installed=false,hookError=''
  if(ctx.app.webhook_ciphertext){try{installed=!!(await hookContext(serverId,appId)).existing}catch(error){hookError=(error as Error).message}}
  return{autoDeploy:ctx.app.auto_deploy,branch:ctx.app.branch,hasSecret:!!ctx.app.webhook_ciphertext,webhookUrl:ctx.url,installed,hookError}
}
export async function changeRemoteGit(serverId:string,appId:string,body:Record<string,unknown>,actor:string){
  await ensureManagedServers();uuid(serverId);uuid(appId)
  const client=await db.connect();let locked=false
  try{
    locked=(await client.query("select pg_try_advisory_lock(hashtext('remote-webhook'),hashtext($1)) as ok",[appId])).rows[0].ok
    if(!locked)throw new ApiError('Another webhook change is running',409)
    const ctx=await context(serverId,appId),action=body.action
    let secret:string|undefined
    if(action==='auto'){
      if(typeof body.enabled!=='boolean')throw new ApiError('Choose whether pushes deploy automatically',400)
      await query('update remote_apps set auto_deploy=$3,webhook_user_id=$4 where server_id=$1 and id=$2',[serverId,appId,body.enabled,actor])
    }else if(action==='generate'){
      if(ctx.app.webhook_ciphertext)throw new ApiError('A webhook secret already exists. Connect it automatically or disconnect before generating another.',409)
      secret=randomBytes(32).toString('hex')
      await query('update remote_apps set webhook_ciphertext=$3,webhook_user_id=$4 where server_id=$1 and id=$2',[serverId,appId,encryptSecret(secret),actor])
    }else if(action==='connect'||action==='disconnect'){
      const hook=await hookContext(serverId,appId)
      if(action==='connect'){
        secret=ctx.app.webhook_ciphertext?decryptSecret(ctx.app.webhook_ciphertext):randomBytes(32).toString('hex')
        const config={url:ctx.url,content_type:'json',secret,insecure_ssl:'0'}
        const payload=ctx.host.provider==='gitlab'?{url:ctx.url,token:secret,push_events:true,tag_push_events:false,enable_ssl_verification:true}:ctx.host.provider==='gitea'?{type:'gitea',active:true,events:['push'],config}:{name:'web',active:true,events:['push'],config}
        const response=await gitApi(ctx.host,hook.token,hook.endpoint+(hook.existing?'/'+hook.existing.id:''),{method:hook.existing?(ctx.host.provider==='gitlab'?'PUT':'PATCH'):'POST',body:payload})
        if(!response.ok)throw new ApiError(`Git server rejected webhook configuration (HTTP ${response.status})`,502)
        if(!(await query('update remote_apps set webhook_ciphertext=$3,webhook_user_id=$4 where server_id=$1 and id=$2 and repo_url=$5 and git_connection_id is not distinct from $6',[serverId,appId,encryptSecret(secret),actor,ctx.app.repo_url,ctx.app.git_connection_id])).rowCount)throw new ApiError('Application repository changed. Refresh and connect its current repository.',409)
      }else{
        if(hook.existing){const response=await gitApi(ctx.host,hook.token,hook.endpoint+'/'+hook.existing.id,{method:'DELETE'});if(!response.ok&&response.status!==404)throw new ApiError('Could not remove this application webhook',502)}
        await query('update remote_apps set webhook_ciphertext=null,auto_deploy=false where server_id=$1 and id=$2',[serverId,appId])
      }
    }else throw new ApiError('Unknown Git automation action',400)
    await query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.webhook.'+action,appId,JSON.stringify({serverId})])
    return{...await remoteGitStatus(serverId,appId),...(action==='generate'?{secret}:{})}
  }finally{try{if(locked)await client.query("select pg_advisory_unlock(hashtext('remote-webhook'),hashtext($1))",[appId])}finally{client.release()}}
}
export async function receiveRemotePush(serverId:string,appId:string,raw:string,headers:Headers){
  const {app,host}=await context(serverId,appId)
  let push;try{push=remotePush(host.provider,raw,headers,app.webhook_ciphertext?decryptSecret(app.webhook_ciphertext):'')}catch{throw new ApiError('Invalid webhook signature or payload',401)}
  if(!push)return{status:'ignored'}
  if(!app.auto_deploy||!app.webhook_user_id||push.branch!==app.branch||push.repository!==repositoryUrl(app.repo_url))return{status:'ignored'}
  const job=await queueRemoteDeploy(serverId,appId,app.webhook_user_id,{webhook:{...push,secretHash:createHash('sha256').update(app.webhook_ciphertext).digest('hex')}})
  return{status:'queued',deploymentId:job.id}
}
