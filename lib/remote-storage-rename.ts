import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {query} from './db'
import {decryptSecret} from './secret-crypto'
import {uuid} from './managed-servers'
import {ensureRemoteStorage,remoteStorageService,syncRemotePrimaryMetadata} from './remote-storage'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
import {parseDatabaseEnv,databaseKey} from './database-discovery-policy'
import {remoteEnvironmentFiles} from './remote-environment'
import {parseEnvironmentText} from './environment-text'
async function plan(client:PoolClient,serverId:string,id:string){
  const item=await remoteStorageService(client,serverId,id)
  if(item.provider!=='postgresql'||!item.provisioning_enabled)throw new ApiError('Renaming requires a saved PostgreSQL administrator connection',409)
  if(['postgres','template0','template1'].includes(item.database_name))throw new ApiError('This database is protected',409)
  const linked=(await client.query(`select s.* from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.database_name=$5 order by s.id`,[serverId,item.provider,item.host,item.port,item.database_name])).rows
  const all=(await client.query('select * from remote_apps where server_id=$1 order by id',[serverId])).rows
  const apps=all.flatMap(app=>{
    const files=remoteEnvironmentFiles(app),settings=Object.entries(files).flatMap(([file,content])=>parseDatabaseEnv(file,parseEnvironmentText(content)).filter(d=>databaseKey(d.engine,d.host,d.port,d.database)===databaseKey(item.provider,item.host,item.port,item.database_name)).map(d=>d.source))
    settings.push(...linked.filter(s=>s.app_id===app.id).map(s=>`Manager Storage: ${s.env_prefix}`))
    return settings.length?[{projectId:app.id,name:app.name,environment:app.environment_name,settings}]:[]
  })
  const review=createHash('sha256').update(JSON.stringify({serverId,item,linked,apps,files:all.filter(a=>apps.some(p=>p.projectId===a.id)).map(a=>[a.id,a.env_ciphertext,a.env_files_ciphertext])})).digest('hex')
  return{item,apps,linked,review}
}
function payload(item:Record<string,any>){return{connection:{provider:item.provider,host:item.host,port:item.port,database:item.database_name,username:item.username,password:decryptSecret(item.password_ciphertext),tls:item.tls_enabled},administrator:{provider:item.provider,host:item.host,port:item.port,database:'postgres',username:item.administrator,password:decryptSecret(item.administrator_ciphertext),tls:item.tls_enabled}}}
export async function reviewRemoteStorageRename(serverId:string,id:string,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const p=await plan(client,serverId,id)
    return enqueueResource(client,serverId,{action:'storage',operation:'rename-plan',serviceId:id,serverName:p.item.connection_name,apps:p.apps,review:p.review,...payload(p.item)},actor,p.item.options.untracked?p.item.connection_id:id)
  })
}
export async function renameRemoteStorage(serverId:string,id:string,body:Record<string,unknown>,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const p=await plan(client,serverId,id)
    if(body.review!==p.review)throw new ApiError('The database or its apps changed. Refresh the rename checks.',409)
    if(body.confirm!==p.item.database_name||body.acknowledge!==true)throw new ApiError('Type the current database name and acknowledge updating every connection',400)
    if(typeof body.newName!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(body.newName)||['postgres','template0','template1',p.item.database_name].includes(body.newName))throw new ApiError('Choose a different database name using letters, numbers and underscores',400)
    if((await client.query("select 1 from remote_storage_renames where server_id=$1 and status in ('running','needs_review')",[serverId])).rowCount)throw new ApiError('Verify the outcome of the earlier database rename first',409)
    const operationId=randomUUID()
    await client.query('insert into remote_storage_renames(id,server_id,connection_id,service_id,old_name,new_name,apps,service_ids,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[operationId,serverId,p.item.connection_id,id,p.item.database_name,body.newName,JSON.stringify(p.apps),JSON.stringify(p.linked.map(s=>s.id)),actor])
    const job=await enqueueResource(client,serverId,{action:'storage',operation:'rename',serviceId:id,operationId,newName:body.newName,...payload(p.item)},actor,p.item.options.untracked?p.item.connection_id:id)
    await client.query('update remote_storage_renames set job_id=$2 where id=$1',[operationId,job.jobId]);return job
  })
}
export async function listRemoteStorageRenames(serverId:string){await ensureRemoteStorage(serverId);return(await query("select id,old_name,new_name,apps,status,error from remote_storage_renames where server_id=$1 and status in ('running','needs_review','succeeded') order by created_at desc limit 100",[serverId])).rows}
export async function reconcileRemoteStorageRename(serverId:string,id:string,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const row=(await client.query("select * from remote_storage_renames where server_id=$1 and id=$2 and status='needs_review' for update",[serverId,uuid(id)])).rows[0];if(!row)throw new ApiError('Rename recovery not found',404)
    const item=await remoteStorageService(client,serverId,row.service_id)
    const job=await enqueueResource(client,serverId,{action:'storage',operation:'rename-reconcile',serviceId:item.id,operationId:row.id,newName:row.new_name,...payload({...item,database_name:row.old_name})},actor,item.options.untracked?item.connection_id:item.id)
    await client.query("update remote_storage_renames set job_id=$2,status='running',error=null where id=$1",[row.id,job.jobId]);return job
  })
}
export async function finishRemoteStorageRename(client:PoolClient,serverId:string,resource:Record<string,any>,success:boolean,result:Record<string,any>|null){
  const row=(await client.query('select * from remote_storage_renames where server_id=$1 and id=$2 for update',[serverId,uuid(resource.operationId)])).rows[0]
  if(!row||row.service_id!==resource.serviceId||row.old_name!==resource.connection.database||row.new_name!==resource.newName)throw new ApiError('Rename receipt does not match the reviewed operation',400)
  if(!success){await client.query("update remote_storage_renames set status='needs_review',error='Verify the old and new database names before retrying. Saved application files were not changed.',finished_at=now() where id=$1",[row.id]);return}
  if(!result||result.operationId!==row.id||result.oldName!==row.old_name||result.renamed!==true&&result.unchanged!==true||result.database!==(result.renamed?row.new_name:row.old_name))throw new ApiError('Invalid database rename acknowledgement',400)
  if(result.renamed){
    const updated=await client.query('update remote_storage_services set database_name=$3,updated_at=now() where server_id=$1 and id=any($2::uuid[]) and database_name=$4 returning app_id',[serverId,row.service_ids,row.new_name,row.old_name])
    if(updated.rowCount!==row.service_ids.length)throw new ApiError('Database links changed; the rename needs review',409)
    for(const appId of new Set(updated.rows.map(s=>s.app_id)))await syncRemotePrimaryMetadata(client,serverId,appId)
    const connection=(await client.query('select options from remote_storage_connections where server_id=$1 and id=$2 for update',[serverId,row.connection_id])).rows[0]
    if(connection){const owned=(connection.options.createdDatabases||[]).map((d:Record<string,any>)=>d.name===row.old_name?{...d,name:row.new_name}:d);await client.query("update remote_storage_connections set options=jsonb_set(options-'inventory','{createdDatabases}',$3::jsonb) where server_id=$1 and id=$2",[serverId,row.connection_id,JSON.stringify(owned)])}
  }
  await client.query('update remote_storage_renames set status=$2,error=null,finished_at=now() where id=$1',[row.id,result.renamed?'succeeded':'failed'])
}
