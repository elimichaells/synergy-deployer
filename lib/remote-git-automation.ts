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
async function application(serverId:string,appId:string){
  await ensureManagedServers()
  const app=(await query('select * from remote_apps where server_id=$1 and id=$2',[uuid(serverId),uuid(appId)])).rows[0]
  if(!app)throw new ApiError('Application not found on this server',404)
  return app
}
async function context(serverId:string,appId:string){
  const app=await application(serverId,appId)
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
  const app=await application(serverId,appId)
  let installed=false,hookError=''
  if(app.webhook_ciphertext){try{const {existing,host}=await hookContext(serverId,appId);installed=!!existing&&(host.provider==='gitlab'?existing.push_events!==false&&existing.enable_ssl_verification!==false:existing.active!==false&&(!existing.events||existing.events.includes('push')||existing.events.includes('*'))&&existing.config?.insecure_ssl!=='1');if(!installed)hookError='The Git webhook is missing, disabled, or is not configured for verified push delivery. Connect it again.'}catch(error){hookError=(error as Error).message}}
  return{autoDeploy:app.auto_deploy,branch:app.branch,hasSecret:!!app.webhook_ciphertext,webhookUrl:remoteWebhookUrl(serverId,appId),installed,hookError}
}
export async function changeRemoteGit(serverId:string,appId:string,body:Record<string,unknown>,actor:string){
  await ensureManagedServers();uuid(serverId);uuid(appId)
  const client=await db.connect();let locked=false
  try{
    locked=(await client.query("select pg_try_advisory_lock(hashtext('remote-webhook'),hashtext($1)) as ok",[appId])).rows[0].ok
    if(!locked)throw new ApiError('Another webhook change is running',409)
    const app=await application(serverId,appId),action=body.action
    let secret:string|undefined
    if(action==='auto'&&typeof body.enabled!=='boolean')throw new ApiError('Choose whether pushes deploy automatically',400)
    if(action==='auto'&&body.enabled===false){
      // Disabling must work even if the Git connection has expired or was removed.
      await query('update remote_apps set auto_deploy=$3,webhook_user_id=$4 where server_id=$1 and id=$2',[serverId,appId,false,actor])
    }else if(action==='generate'){
      if(app.webhook_ciphertext)throw new ApiError('A webhook secret already exists. Connect it automatically or disconnect before generating another.',409)
      secret=randomBytes(32).toString('hex')
      await query('update remote_apps set webhook_ciphertext=$3,webhook_user_id=$4 where server_id=$1 and id=$2',[serverId,appId,encryptSecret(secret),actor])
    }else if(action==='connect'||action==='disconnect'||action==='auto'){
      if(action==='auto'&&app.guided_setup&&!app.setup_completed_at)throw new ApiError('Finish application setup and server checks before enabling auto-deploy',409)
      if(action!=='disconnect'&&!(await query('select id from managed_servers where id=$1 and enabled=true',[serverId])).rowCount)throw new ApiError('Reconnect this server before configuring automatic deployments',409)
      const hook=await hookContext(serverId,appId)
      if(hook.app.repo_url!==app.repo_url||hook.app.git_connection_id!==app.git_connection_id||hook.app.branch!==app.branch)throw new ApiError('Application repository changed. Refresh before configuring its webhook.',409)
      if(action==='connect'||action==='auto'){
        secret=app.webhook_ciphertext?decryptSecret(app.webhook_ciphertext):randomBytes(32).toString('hex')
        const config={url:hook.url,content_type:'json',secret,insecure_ssl:'0'}
        const payload=hook.host.provider==='gitlab'?{url:hook.url,token:secret,push_events:true,tag_push_events:false,enable_ssl_verification:true}:hook.host.provider==='gitea'?{type:'gitea',active:true,events:['push'],config}:{name:'web',active:true,events:['push'],config}
        const response=await gitApi(hook.host,hook.token,hook.endpoint+(hook.existing?'/'+hook.existing.id:''),{method:hook.existing?(hook.host.provider==='gitlab'?'PUT':'PATCH'):'POST',body:payload})
        if(!response.ok)throw new ApiError(`Git server rejected webhook configuration (HTTP ${response.status})`,502)
        // Enable only after the provider accepts the verified push webhook. A
        // concurrent source/setup/server change must not authorize a stale plan.
        if(!(await query(`update remote_apps set webhook_ciphertext=$3,webhook_user_id=$4${action==='auto'?',auto_deploy=true':''} where server_id=$1 and id=$2 and repo_url=$5 and git_connection_id is not distinct from $6 and branch=$7
          and exists(select 1 from managed_servers where id=$1 and enabled=true)${action==='auto'?' and (guided_setup=false or setup_completed_at is not null)':''}`,[serverId,appId,encryptSecret(secret),actor,app.repo_url,app.git_connection_id,app.branch])).rowCount)throw new ApiError('Application repository, setup or server changed. Refresh and connect its current repository.',409)
      }else{
        if(hook.existing){const response=await gitApi(hook.host,hook.token,hook.endpoint+'/'+hook.existing.id,{method:'DELETE'});if(!response.ok&&response.status!==404)throw new ApiError('Could not remove this application webhook',502)}
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
