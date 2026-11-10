import {randomUUID,createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {query} from './db'
import {encryptSecret,decryptSecret} from './secret-crypto'
import {uuid} from './managed-servers'
import {ensureRemoteStorage,remoteStorageService,syncRemotePrimaryMetadata} from './remote-storage'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
type Row=Record<string,any>
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const decode=(value:string)=>JSON.parse(decryptSecret(value))
const credential=(s:Row)=>({provider:s.provider,host:s.host,port:s.port,database:s.database_name,username:s.username,password:decryptSecret(s.password_ciphertext),tls:s.tls_enabled})
const pending=(row:Row)=>['running','needs_review'].includes(row.status)
async function prepare(client:PoolClient,serverId:string,sourceId:string,targetId:string){
  const source=await remoteStorageService(client,serverId,uuid(sourceId)),target=await remoteStorageService(client,serverId,uuid(targetId))
  if(source.id===target.id||source.app_id!==target.app_id)throw new ApiError('Choose two different database services in the same application',409)
  if([source,target].some(s=>!['postgresql','mysql','mariadb','sqlserver'].includes(s.provider)||s.status!=='ready'||!s.password_ciphertext||s.pending_password_ciphertext))throw new ApiError('Test both relational services and finish any password recovery first',409)
  const app=(await client.query('select name from remote_apps where server_id=$1 and id=$2',[serverId,source.app_id])).rows[0]
  const input={action:'storage',operation:'migration-preview',serviceId:source.id,targetServiceId:target.id,connection:credential(source),target:credential(target),source:{id:source.id,name:source.name,provider:source.provider,database:source.database_name,projectId:source.app_id,projectName:app.name},destination:{id:target.id,name:target.name,provider:target.provider,database:target.database_name,applicationPrimary:target.application_primary}}
  return{input,appId:source.app_id,metadataHash:hash({input,sourcePrimary:source.application_primary,targetPrimary:target.application_primary})}
}
export async function previewRemoteMigration(serverId:string,body:Row,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const {input,appId,metadataHash}=await prepare(client,serverId,body.sourceServiceId,body.targetServiceId),id=randomUUID(),payload={...input,operationId:id}
    await client.query("insert into remote_storage_changes(id,server_id,service_id,target_service_id,app_id,kind,metadata_hash,payload_ciphertext,created_by) values($1,$2,$3,$4,$5,'migration',$6,$7,$8)",[id,serverId,input.serviceId,input.targetServiceId,appId,metadataHash,encryptSecret(JSON.stringify(payload)),actor])
    const job=await enqueueResource(client,serverId,payload,actor,input.serviceId);await client.query('update remote_storage_changes set job_id=$2 where id=$1',[id,job.jobId]);return job
  })
}
function publicJob(row:Row){
  const input=decode(row.payload_ciphertext),plan=row.plan_private_ciphertext?decode(row.plan_private_ciphertext):{},result=plan.result||{}
  return{id:row.id,project_id:row.app_id,project_name:input.source.projectName,source_service_id:row.service_id,source_service_name:input.source.name,source_provider:input.source.provider,source_database:input.source.database,target_service_id:row.target_service_id,target_service_name:input.destination.name,target_provider:input.destination.provider,target_database:input.destination.database,status:row.status==='needs_review'?'interrupted':row.status,preserve_schema:!!input.preserveSchema,replace_target:!!input.replaceTarget,table_map:plan.tables||[],validation:result.validation||null,log:result.log||row.error||'',error:row.error,created_at:row.created_at,finished_at:row.finished_at,activated_at:row.status==='activated'?row.finished_at:null,removal_blocked_reason:pending(row)?'Finish or verify the recorded agent outcome before removing this migration.':null,recovery:row.status==='needs_review'}
}
export async function listRemoteMigrations(serverId:string,appId?:string){
  await ensureRemoteStorage(serverId);if(appId)uuid(appId)
  await query("update remote_storage_changes c set status='needs_review',error='Verify the migration journal before retrying.' from remote_jobs j where c.server_id=$1 and c.kind='migration' and c.job_id=j.id and c.status='running' and j.status in ('failed','cancelled')",[serverId])
  return(await query("select * from remote_storage_changes where server_id=$1 and ($2::uuid is null or app_id=$2) and kind='migration' and status not in ('reviewing','preview','preview_failed') order by created_at desc limit 100",[serverId,appId||null])).rows.map(publicJob)
}
export async function startRemoteMigration(serverId:string,body:Row,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    const row=(await client.query("select * from remote_storage_changes where server_id=$1 and id=$2 and kind='migration' for update",[serverId,uuid(body.review)])).rows[0]
    if(!row||row.status!=='preview'||Date.now()-Date.parse(row.created_at)>600000)throw new ApiError('Refresh the migration review first',409)
    await admitResource(client,serverId);const current=await prepare(client,serverId,row.service_id,row.target_service_id),input=decode(row.payload_ciphertext),plan=decode(row.plan_private_ciphertext)
    if(current.metadataHash!==row.metadata_hash||body.sourceServiceId!==row.service_id||body.targetServiceId!==row.target_service_id)throw new ApiError('Database connections changed. Refresh the review',409)
    const tables=Array.isArray(body.tables)?body.tables:plan.tables.map((t:Row)=>t.sourceObject)
    if(!tables.length||new Set(tables).size!==tables.length||tables.some((name:unknown)=>typeof name!=='string'||!plan.tables.some((t:Row)=>t.sourceObject===name)))throw new ApiError('Choose reviewed source tables',400)
    if(body.backupConfirmed!==true||body.writesPaused!==true)throw new ApiError('Confirm a backup and pause source and target writers first',400)
    if(plan.tables.some((t:Row)=>tables.includes(t.sourceObject)&&t.targetExists)&&(body.replaceTarget!==true||body.confirmTarget!==input.target.database))throw new ApiError('Type the target database name to confirm replacement of its existing rows',400)
    const payload={...input,operation:'migration-run',agentReview:plan.agentReview,tables,preserveSchema:body.preserveSchema!==false,replaceTarget:body.replaceTarget===true,backupConfirmed:true,writesPaused:true}
    const job=await enqueueResource(client,serverId,payload,actor,row.service_id);await client.query("update remote_storage_changes set status='running',job_id=$2,payload_ciphertext=$3,error=null,finished_at=null where id=$1",[row.id,job.jobId,encryptSecret(JSON.stringify(payload))]);return{migration:publicJob({...row,status:'running',payload_ciphertext:encryptSecret(JSON.stringify(payload))})}
  })
}
export async function changeRemoteMigration(serverId:string,id:string,action:string,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    const row=(await client.query("select * from remote_storage_changes where server_id=$1 and id=$2 and kind='migration' for update",[serverId,uuid(id)])).rows[0]
    if(!row)throw new ApiError('Migration not found on this server',404)
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.storage.migration.'+action,id,JSON.stringify({serverId,appId:row.app_id})])
    if(action==='cancel'){
      if(row.status!=='running')throw new ApiError('Migration is not active',409)
      const job=(await client.query("update remote_jobs set cancel_requested=true,payload_ciphertext=case when status='queued' then null else payload_ciphertext end,finished_at=case when status='queued' then now() else finished_at end,status=case when status='queued' then 'cancelled' else status end where server_id=$1 and id=$2 and status in ('queued','running') returning status",[serverId,row.job_id])).rows[0]
      if(!job)throw new ApiError('Verify the migration outcome before continuing',409)
      if(job.status==='cancelled')await client.query("update remote_storage_changes set status='cancelled',finished_at=now() where id=$1",[id])
      return{ok:true}
    }
    if(action==='reconcile'){
      if(row.status!=='needs_review')throw new ApiError('This migration does not need recovery',409)
      await admitResource(client,serverId,id);const job=await enqueueResource(client,serverId,{...decode(row.payload_ciphertext),operation:'migration-reconcile'},actor,row.service_id);await client.query("update remote_storage_changes set status='running',job_id=$2 where id=$1",[id,job.jobId]);return job
    }
    if(pending(row))throw new ApiError('Finish or verify this migration first',409)
    await admitResource(client,serverId)
    if(action==='delete'){await client.query('delete from remote_storage_changes where server_id=$1 and id=$2',[serverId,id]);return{ok:true}}
    if(action!=='activate'||row.status!=='succeeded')throw new ApiError('Only a verified successful migration can be activated',409)
    const current=await prepare(client,serverId,row.service_id,row.target_service_id)
    if(current.metadataHash!==row.metadata_hash)throw new ApiError('Database connections changed after this migration. Review them before activation',409)
    const services=(await client.query('select id,name,env_prefix,application_primary from remote_storage_services where server_id=$1 and id=any($2::uuid[]) for update',[serverId,[row.service_id,row.target_service_id]])).rows,source=services.find(s=>s.id===row.service_id)
    await client.query('update remote_storage_services set application_primary=false where server_id=$1 and app_id=$2',[serverId,row.app_id])
    if(source.application_primary){const suffix=randomUUID().replaceAll('-','').slice(0,10).toUpperCase();await client.query('update remote_storage_services set name=$3,env_prefix=$4 where server_id=$1 and id=$2',[serverId,source.id,'legacy_'+suffix.toLowerCase(),'LEGACY_'+suffix]);await client.query('update remote_storage_services set name=$3,env_prefix=$4 where server_id=$1 and id=$2',[serverId,row.target_service_id,source.name,source.env_prefix])}
    await client.query('update remote_storage_services set application_primary=true where server_id=$1 and id=$2',[serverId,row.target_service_id]);await syncRemotePrimaryMetadata(client,serverId,row.app_id);await client.query("update remote_storage_changes set status='activated',finished_at=now() where id=$1",[id]);await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.storage.migration.activate',id,JSON.stringify({serverId,appId:row.app_id})]);return{ok:true}
  })
}
export async function finishRemoteMigration(client:PoolClient,serverId:string,resource:Row,success:boolean,result:Row|null){
  const row=(await client.query("select * from remote_storage_changes where server_id=$1 and id=$2 and kind='migration' for update",[serverId,uuid(resource.operationId)])).rows[0]
  if(!row||row.service_id!==resource.serviceId||row.target_service_id!==resource.targetServiceId)throw new ApiError('Migration receipt does not match its operation',400)
  const input=decode(row.payload_ciphertext)
  if(resource.operation==='migration-preview'){
    if(success&&(!Array.isArray(result?.preview?.tables)||result.preview.review!==row.id||!/^[a-f0-9]{64}$/.test(result.preview.agentReview)))throw new ApiError('Invalid migration preview',400)
    if(success)Object.assign(result!.preview,{source:input.source,target:input.destination})
    await client.query('update remote_storage_changes set status=$2,plan_private_ciphertext=$3 where id=$1',[row.id,success?'preview':'preview_failed',success?encryptSecret(JSON.stringify(result!.preview)):null]);return
  }
  if(!success){await client.query("update remote_storage_changes set status='needs_review',error='Connection ended without a verified outcome. Verify the agent journal before another migration.' where id=$1",[row.id]);return}
  if(!result||result.operationId!==row.id||!['succeeded','failed','cancelled','interrupted'].includes(result.status))throw new ApiError('Invalid migration outcome',400)
  const plan=decode(row.plan_private_ciphertext)
  if(result.status==='succeeded'&&(!Array.isArray(result.validation)||result.validation.length!==input.tables.length||new Set(result.validation.map((t:Row)=>t.table)).size!==input.tables.length||result.validation.some((t:Row)=>!input.tables.includes(t.table)||t.target!==plan.tables.find((p:Row)=>p.sourceObject===t.table)?.targetObject||t.match!==true||!/^\d+$/.test(t.sourceRows)||t.sourceRows!==t.targetRows)))throw new ApiError('Migration verification did not match the selected tables',400)
  await client.query('update remote_storage_changes set status=$2,error=$3,plan_private_ciphertext=$4,finished_at=now() where id=$1',[row.id,result.status,result.error||null,encryptSecret(JSON.stringify({...plan,result}))])
}
