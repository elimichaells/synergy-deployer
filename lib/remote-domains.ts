import { isIP } from 'node:net'
import { ApiError } from './api'
import { db, query } from './db'
import { randomUUID } from 'node:crypto'
import { cfRequest,ensureCloudflareSchema,getZone,hostname,secretConnection,zoneSsl } from './cloudflare'
import { decryptSecret } from './secret-crypto'
import { serverDetail,uuid } from './managed-servers'
import { queueInfrastructure } from './remote-infrastructure'
import { lanAddress, parseLanAddress } from '../scripts/lan-address.cjs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeRoutePrefix,orderRoutes,stackRouteProblem } from './domain-route-policy'
import type { DomainRoute } from './domain-routes'

let routeSchema:Promise<unknown>|undefined
export function ensureRemoteDomainRoutes(){return routeSchema??=ensureCloudflareSchema().then(async()=>query(await readFile(path.join(process.cwd(),'db/migrations/032_remote_domain_routes.sql'),'utf8'))).catch(error=>{routeSchema=undefined;throw error})}
export async function listRemoteDomainRoutes(serverId:string,appId?:string){
  await ensureRemoteDomainRoutes();await serverDetail(serverId);if(appId)uuid(appId)
  return orderRoutes((await query<DomainRoute & {server_id:string;deleting:boolean;operation_status:string;last_error:string|null}>(`select r.*,d.hostname,d.project_id as domain_project_id,dp.name as domain_project_name,p.name as project_name,p.component_role,j.status as operation_status,d.last_error
    from remote_domain_routes r join remote_domains d on d.id=r.domain_id join remote_apps dp on dp.id=d.project_id join remote_apps p on p.id=r.project_id left join remote_jobs j on j.id=d.job_id
    where r.server_id=$1 and ($2::uuid is null or r.project_id=$2 or d.project_id=$2)`,[serverId,appId||null])).rows)
}
export async function changeRemoteDomainRoute(serverId:string,id:string|null,body:Record<string,unknown>,userId:string){
  await ensureRemoteDomainRoutes()
  return locked(serverId,async()=>{
    let domainId:string
    if(id){uuid(id);const row=(await query('select * from remote_domain_routes where server_id=$1 and id=$2',[serverId,id])).rows[0];if(!row)throw new ApiError('Route not found on this server',404);domainId=row.domain_id;await query('update remote_domain_routes set deleting=true where id=$1',[id])}
    else {
      const targetId=uuid(body.projectId);domainId=uuid(body.domainId)
      const domain=await domainRow(serverId,domainId),{apps}=await serverDetail(serverId),owner=apps.find(a=>a.id===domain.project_id),target=apps.find(a=>a.id===targetId)
      if(!owner||!target)throw new ApiError('Domain and application must belong to this server',404)
      const problem=stackRouteProblem({domainProjectId:owner.id,domainGroupId:owner.application_group_id||null,domainEnvironment:owner.environment_name||'production',targetProjectId:target.id,targetGroupId:target.application_group_id||null,targetEnvironment:target.environment_name||'production',targetPort:target.live_commit?target.port:null})
      if(problem)throw new ApiError(problem,400)
      let prefix:string;try{prefix=normalizeRoutePrefix(body.pathPrefix)}catch(error){throw new ApiError((error as Error).message,400)}
      if(Number((await query('select count(*) as count from remote_domain_routes where domain_id=$1',[domainId])).rows[0].count)>=100)throw new ApiError('This domain already has 100 shared paths. Remove an unused path before adding another.',409)
      try{await query('insert into remote_domain_routes(server_id,domain_id,project_id,path_prefix,strip_prefix) values($1,$2,$3,$4,$5)',[serverId,domainId,targetId,prefix,body.stripPrefix===true])}catch(error){if((error as {code?:string}).code==='23505')throw new ApiError('This path already exists. Sync its domain to retry an interrupted operation.',409);throw error}
    }
    const row=await domainRow(serverId,domainId)
    try{await queueRoute(row,userId);await waitRoute(serverId,domainId);await query('delete from remote_domain_routes where domain_id=$1 and deleting=true',[domainId]);return{ok:true}}
    catch(error){await query('update remote_domains set last_error=$2 where id=$1',[domainId,(error as Error).message]);throw error}
  })
}

async function domainRow(serverId:string,id:string){await ensureCloudflareSchema();uuid(serverId);uuid(id);const row=(await query('select * from remote_domains where server_id=$1 and id=$2',[serverId,id])).rows[0];if(!row)throw new ApiError('Domain not found on this server',404);return row}
export async function listRemoteDomains(serverId:string){
  await ensureCloudflareSchema();await serverDetail(serverId)
  const rows=(await query(`select d.*,a.name as project_name,a.environment_name as environment,c.name as cloudflare_connection_name,
    j.status as operation_status,j.log as operation_log from remote_domains d join remote_apps a on a.id=d.project_id left join cloudflare_connections c on c.id=d.cloudflare_connection_id left join remote_jobs j on j.id=d.job_id where d.server_id=$1 order by d.hostname`,[serverId])).rows
  // Existing application hostnames remain visible even before DNS is connected.
  const {apps}=await serverDetail(serverId)
  return [...rows,...apps.filter(a=>a.hostname&&!a.hostname.endsWith('.invalid')&&!rows.some(d=>d.hostname===a.hostname)).map(a=>({id:a.id,project_id:a.id,project_name:a.name,environment:a.environment_name,hostname:a.hostname,record_type:'',record_content:'Configured in application',dns_status:parseLanAddress(a.hostname)?'lan':'manual',ssl_status:parseLanAddress(a.hostname)?'Local CA':'Application route',proxied:false,is_primary:true,application_route:true}))]
}
async function waitRoute(serverId:string,id:string){
  const until=Date.now()+45000
  while(Date.now()<until){const row=await domainRow(serverId,id);const job=row.job_id?(await query('select status,log from remote_jobs where id=$1 and server_id=$2',[row.job_id,serverId])).rows[0]:null
    if(job?.status==='success')return row
    if(!job||!['queued','running'].includes(job.status))throw new ApiError(job?.log||'The route was not queued. Sync this domain to retry.',409)
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
  throw new ApiError('The server has not confirmed the route yet. Its operation is retained; use Sync after it reconnects.',409)
}
async function queueRoute(row:Record<string,any>,userId:string,remove=false){
  await ensureRemoteDomainRoutes()
  const routes=remove?[]:(await query<{id:string;appId:string;prefix:string;stripPrefix:boolean}>('select id,project_id as "appId",path_prefix as prefix,strip_prefix as "stripPrefix" from remote_domain_routes where server_id=$1 and domain_id=$2 and not deleting order by length(path_prefix) desc,path_prefix',[row.server_id,row.id])).rows
  const operation=await queueInfrastructure(row.server_id,row.project_id,'domain',userId,{id:row.id,hostname:row.hostname,remove,routes,...(remove&&row.is_primary?{restoreHostname:row.previous_hostname,restoreAccessMode:row.previous_access_mode}:{})})
  await query('update remote_domains set job_id=$2,deleting=$3,last_error=null where id=$1',[row.id,operation.jobId,remove])
}
async function createDomain(serverId:string,input:Record<string,unknown>,userId:string){
  await ensureCloudflareSchema();const {apps}=await serverDetail(serverId),projectId=uuid(input.projectId),app=apps.find(a=>a.id===projectId)
  if(!app?.live_commit)throw new ApiError('Deploy the selected application before adding a domain',409)
  let lan = null
  try { lan=input.mode==='lan'?lanAddress(input.lanIp,input.lanPort??8443):null }
  catch(error){throw new ApiError((error as Error).message,400)}
  const name=lan?lan.authority:hostname(input.hostname),type=lan?(lan.family===6?'AAAA':'A'):String(input.recordType||'A'),content=lan?lan.ip:String(input.recordContent||'').trim(),manual=input.mode==='manual'||!!lan
  if(lan&&apps.some(a=>a.port===lan.port||a.ip_port===lan.port&&a.hostname!==name))throw new ApiError('This LAN HTTPS port is already assigned on the server',409)
  if(!['A','AAAA','CNAME'].includes(type)||type==='A'&&isIP(content)!==4||type==='AAAA'&&isIP(content)!==6||!content)throw new ApiError('Enter a valid DNS record target',400)
  if(type==='CNAME')hostname(content)
  const conflicts=lan?await query('select id from remote_domains where server_id=$1 and hostname=$2',[serverId,name]):await query('select id from project_domains where hostname=$1 union all select id from remote_domains where hostname=$1',[name])
  if(apps.some(a=>a.id!==projectId&&a.hostname===name)||conflicts.rowCount)throw new ApiError('This address is already assigned',409)
  const connection=manual?null:await secretConnection(uuid(input.cloudflareConnectionId)),zone=connection?await getZone(connection,name):null
  if(zone&&(await cfRequest<any[]>(zone.token,`/zones/${zone.zone.id}/dns_records?name=${encodeURIComponent(name)}`)).length)throw new ApiError('This DNS name already exists. Select manual DNS to preserve its existing records.',409)
  const row=(await query(`insert into remote_domains(server_id,project_id,hostname,cloudflare_connection_id,cloudflare_zone_id,record_type,record_content,proxied,is_primary,previous_hostname,previous_access_mode) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,[serverId,projectId,name,connection?.id||null,zone?.zone.id||null,type,content,!manual&&input.proxied!==false,input.isPrimary===true,app.hostname,app.access_mode])).rows[0]
  try{await queueRoute(row,userId);await waitRoute(serverId,row.id);return await syncDomain(serverId,row.id,userId)}catch(error){await query('update remote_domains set last_error=$2 where id=$1',[row.id,(error as Error).message]);throw error}
}
async function syncDomain(serverId:string,id:string,userId:string){
  let row=await domainRow(serverId,id)
  if(row.deleting)return deleteDomain(serverId,id,userId)
  try{
    const job=row.job_id?(await query('select status from remote_jobs where id=$1 and server_id=$2',[row.job_id,serverId])).rows[0]:null
    if(!job||['failed','cancelled'].includes(job.status)||row.last_error&&!['queued','running'].includes(job.status)){await queueRoute(row,userId);row=await domainRow(serverId,id)}
    await waitRoute(serverId,id)
    await ensureRemoteDomainRoutes();await query('delete from remote_domain_routes where domain_id=$1 and deleting=true',[id])
    if(row.is_primary){
      const changed=await query("update remote_apps set hostname=$3,access_mode=$5 where id=$1 and server_id=$2 and hostname in ($3,$4)",[row.project_id,serverId,row.hostname,row.previous_hostname,parseLanAddress(row.hostname)?'lan':'wan']);
      if(!changed.rowCount)throw new ApiError('Application hostname changed during domain setup. Review it before retrying.',409)
      await query('update remote_domains set is_primary=false where project_id=$1 and id<>$2',[row.project_id,id])
    }
    if(!row.cloudflare_connection_id){await query("update remote_domains set dns_status=$2,ssl_status=$3,last_error=null where id=$1",[id,parseLanAddress(row.hostname)?'lan':'manual',parseLanAddress(row.hostname)?'Local CA':'Route loaded']);return {ok:true}}
    const connection=await secretConnection(row.cloudflare_connection_id),token=decryptSecret(connection.token_ciphertext),base=`/zones/${row.cloudflare_zone_id}/dns_records`
    const comment=`Manager remote domain ${id}`
    let record:any
    if(row.cloudflare_record_id)record=await cfRequest(token,`${base}/${row.cloudflare_record_id}`)
    else{
      const existing=await cfRequest<any[]>(token,`${base}?name=${encodeURIComponent(row.hostname)}`)
      if(existing.length&&!(existing.length===1&&existing[0].comment===comment))throw new ApiError('An unmanaged DNS record now exists. It has been preserved.',409)
      record=existing[0]||await cfRequest(token,base,{method:'POST',body:JSON.stringify({type:row.record_type,name:row.hostname,content:row.record_content,proxied:row.proxied,ttl:1,comment})})
      await query('update remote_domains set cloudflare_record_id=$2 where id=$1',[id,record.id])
    }
    const ssl=await zoneSsl(token,row.cloudflare_zone_id)
    await query("update remote_domains set dns_status='active',ssl_status=$2,ssl_mode=$3,record_content=$4,proxied=$5,last_error=null where id=$1",[id,ssl==='strict'?'strict':'attention',ssl,record.content,record.proxied])
    return {ok:true}
  }catch(error){await query("update remote_domains set dns_status='attention',last_error=$2 where id=$1",[id,(error as Error).message]);throw error}
}
async function deleteDomain(serverId:string,id:string,userId:string){
  let row=await domainRow(serverId,id)
  const job=row.job_id?(await query('select status from remote_jobs where id=$1 and server_id=$2',[row.job_id,serverId])).rows[0]:null
  if(!row.deleting||!job||['failed','cancelled'].includes(job.status)){await queueRoute(row,userId,true);row=await domainRow(serverId,id)}
  await waitRoute(serverId,id)
  if(row.cloudflare_record_id){const connection=await secretConnection(row.cloudflare_connection_id),token=decryptSecret(connection.token_ciphertext),base=`/zones/${row.cloudflare_zone_id}/dns_records`
    const records=await cfRequest<any[]>(token,`${base}?name=${encodeURIComponent(row.hostname)}`),record=records.find(r=>r.id===row.cloudflare_record_id)
    if(record){if(record.comment!==`Manager remote domain ${id}`)throw new ApiError('DNS ownership changed; the record is preserved for manual review',409);await cfRequest(token,`${base}/${record.id}`,{method:'DELETE'})}
  }
  if(row.is_primary)await query('update remote_apps set hostname=$3,access_mode=$4 where id=$1 and server_id=$2 and hostname=$5',[row.project_id,serverId,row.previous_hostname,row.previous_access_mode,row.hostname])
  await query('delete from remote_domains where id=$1 and server_id=$2',[id,serverId]);return {ok:true}
}

async function locked<T>(serverId:string,operation:()=>Promise<T>){
  await ensureCloudflareSchema();await serverDetail(serverId)
  const lease=await db.connect()
  let acquired=false
  try{
  acquired=(await lease.query("select pg_try_advisory_lock(hashtext('manager-remote-domains'),hashtext($1)) as acquired",[serverId])).rows[0].acquired
  if(!acquired)throw new ApiError('Another domain operation or server removal is active. Retry when it finishes.',409)
  await serverDetail(serverId)
  const owner=randomUUID(),lock=await query("insert into remote_domain_operations(server_id,owner,expires_at) values($1,$2,now()+interval '3 minutes') on conflict(server_id) do update set owner=excluded.owner,expires_at=excluded.expires_at where remote_domain_operations.expires_at<now() returning owner",[serverId,owner])
  if(!lock.rowCount)throw new ApiError('Another domain operation is active on this server. Interrupted operations can be retried after three minutes.',409)
  try{return await operation()}finally{await query('delete from remote_domain_operations where server_id=$1 and owner=$2',[serverId,owner])}
  }finally{try{if(acquired)await lease.query("select pg_advisory_unlock(hashtext('manager-remote-domains'),hashtext($1))",[serverId])}finally{lease.release()}}
}
export const createRemoteDomain=(serverId:string,input:Record<string,unknown>,userId:string)=>locked(serverId,()=>createDomain(serverId,input,userId))
export const syncRemoteDomain=(serverId:string,id:string,userId:string)=>locked(serverId,()=>syncDomain(serverId,id,userId))
export const deleteRemoteDomain=(serverId:string,id:string,userId:string)=>locked(serverId,()=>deleteDomain(serverId,id,userId))
