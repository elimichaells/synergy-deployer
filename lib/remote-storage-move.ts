import {createHash,randomBytes,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {query} from './db'
import {decryptSecret,encryptSecret} from './secret-crypto'
import {ensureRemoteStorage,syncRemotePrimaryMetadata} from './remote-storage'
import {prepareRemoteStorageChange} from './remote-storage-changes'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
import {remoteEnvironmentFiles} from './remote-environment'
import {parseEnvironmentText} from './environment-text'
import {uuid} from './managed-servers'
import {hostKey,rewrite} from '../scripts/database-env-rewrite.cjs'
type Row=Record<string,any>
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function prepare(client:PoolClient,serverId:string,id:string,targetId?:string){
  const base=await prepareRemoteStorageChange(client,serverId,id),source=base.input.connection
  const connections=(await client.query("select * from remote_storage_connections where server_id=$1 and provider='postgresql' and provisioning_enabled and last_status='healthy' order by created_at",[serverId])).rows
  const targets=connections.filter(c=>hostKey(c.host)!==hostKey(source.host)||Number(c.port)!==source.port)
  const target=targetId?targets.find(c=>c.id===targetId):targets[0]
  if(targetId&&!target)throw new ApiError('The reviewed destination is no longer a verified PostgreSQL connection',409)
  const input={...base.input,operation:'move-plan',target:target?{provider:'postgresql',host:target.host,port:target.port,database:'postgres',username:target.username,password:decryptSecret(target.password_ciphertext),tls:target.tls_enabled}:null,targetId:target?.id||null,targetName:target?.name||null}
  return{input,metadataHash:hash({source:base.metadataHash,target:target?[target.id,target.host,target.port,target.username,target.password_ciphertext,target.tls_enabled]:null})}
}
const display=(row:Row)=>({id:row.id,status:row.status==='needs_review'?'interrupted':row.status,log:row.error||(row.status==='succeeded'?'The agent verified the copy and switched the linked applications. The original database is preserved.':row.status==='rolled_back'?'The applications use the original database. No source data was deleted.':''),error:row.error,copy_path:null,started_at:row.created_at,finished_at:row.finished_at})
export async function remoteStorageMove(serverId:string,id:string){await ensureRemoteStorage(serverId);const row=(await query("select * from remote_storage_changes where server_id=$1 and id=$2 and kind='move'",[serverId,uuid(id)])).rows[0];if(!row)throw new ApiError('Database move not found on this server',404);return{move:display(row)}}
export async function reviewRemoteStorageMove(serverId:string,id:string,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await client.query("update remote_storage_changes c set status='needs_review',error='Verify the recorded agent outcome before another database change.' from remote_jobs j where c.job_id=j.id and c.server_id=$1 and c.status='running' and j.status in ('failed','cancelled')",[serverId])
    const pending=(await client.query("select * from remote_storage_changes where server_id=$1 and service_id=$2 and kind='move' and status in ('running','needs_review') order by created_at desc limit 1",[serverId,uuid(id)])).rows[0]
    if(pending)return{plan:null,canMove:true,latest:display(pending),recovery:{id:pending.id,status:pending.status}}
    await admitResource(client,serverId);const {input,metadataHash}=await prepare(client,serverId,id),operationId=randomUUID(),payload={...input,operationId}
    await client.query("insert into remote_storage_changes(id,server_id,service_id,kind,metadata_hash,payload_ciphertext,created_by) values($1,$2,$3,'move',$4,$5,$6)",[operationId,serverId,id,metadataHash,encryptSecret(JSON.stringify(payload)),actor])
    const job=await enqueueResource(client,serverId,payload,actor,id);await client.query('update remote_storage_changes set job_id=$2 where id=$1',[operationId,job.jobId]);return job
  })
}
export async function changeRemoteStorageMove(serverId:string,id:string,body:Row,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    const row=(await client.query("select * from remote_storage_changes where server_id=$1 and service_id=$2 and id=$3 and kind='move' for update",[serverId,uuid(id),uuid(body.reconcile||body.review)])).rows[0]
    if(!row)throw new ApiError('Refresh the database move review first',409)
    await admitResource(client,serverId,row.id);let input=JSON.parse(decryptSecret(row.payload_ciphertext))
    if(body.reconcile){if(row.status!=='needs_review')throw new ApiError('This move does not need recovery',409);input={...input,operation:'move-reconcile'}}
    else{
      if(row.status!=='preview'||Date.now()-Date.parse(row.created_at)>600000)throw new ApiError('This move review expired. Refresh the checks.',409)
      const current=await prepare(client,serverId,id,input.targetId),plan=JSON.parse(decryptSecret(row.plan_private_ciphertext))
      if(current.metadataHash!==row.metadata_hash)throw new ApiError('The database links or destination changed. Refresh the checks.',409)
      if(body.confirm!==input.connection.database)throw new ApiError('Type the database name to confirm the move',400)
      if(plan.blockers?.length)throw new ApiError(plan.blockers.join(' '),409)
      input={...input,operation:'move',agentReview:plan.agentReview,role:plan.roleName,database:plan.targetDatabase,password:randomBytes(32).toString('base64url')}
    }
    const job=await enqueueResource(client,serverId,input,actor,id);await client.query("update remote_storage_changes set status='running',job_id=$2,payload_ciphertext=$3,error=null where id=$1",[row.id,job.jobId,encryptSecret(JSON.stringify(input))]);return job
  })
}
export async function finishRemoteStorageMove(client:PoolClient,serverId:string,resource:Row,success:boolean,result:Row|null){
  const row=(await client.query("select * from remote_storage_changes where server_id=$1 and id=$2 and kind='move' for update",[serverId,uuid(resource.operationId)])).rows[0]
  if(!row||row.service_id!==resource.serviceId)throw new ApiError('The database move receipt does not match its review',400)
  if(resource.operation==='move-plan'){
    if(success&&(!result?.plan||result.plan.review!==row.id||!/^[a-f0-9]{64}$/.test(result.plan.agentReview)))throw new ApiError('Invalid database move review',400)
    await client.query('update remote_storage_changes set status=$2,plan_private_ciphertext=$3,finished_at=now() where id=$1',[row.id,success?'preview':'failed',success?encryptSecret(JSON.stringify(result!.plan)):null]);return
  }
  if(!success){await client.query("update remote_storage_changes set status='needs_review',error='The connection ended without a verified outcome. Reopen Move and verify the agent journal.',finished_at=now() where id=$1",[row.id]);return}
  if(!result||result.operationId!==row.id||result.accepted!==true&&result.rolledBack!==true)throw new ApiError('Invalid database move acknowledgement',400)
  if(result.accepted){
    const input=JSON.parse(decryptSecret(row.payload_ciphertext)),current=await prepare(client,serverId,row.service_id,input.targetId)
    if(current.metadataHash!==row.metadata_hash)throw new ApiError('Saved database settings changed during the move. Reconcile before continuing.',409)
    if(result.role!==input.role||result.database!==input.database||!Number.isInteger(result.oid)||!Array.isArray(result.apps)||result.apps.length!==input.apps.length||new Set(result.apps.map((a:Row)=>a.id)).size!==input.apps.length||!input.apps.every((a:Row)=>result.apps.some((r:Row)=>r.id===a.id)))throw new ApiError('The move acknowledgement changed the reviewed database or applications',400)
    const target={...input.target,database:input.database,username:input.role,password:input.password}
    const updated=await client.query("update remote_storage_services set connection_id=$3,database_name=$4,username=$5,password_ciphertext=$6,status='ready',options=options||'{\"ownership\":\"manager\"}'::jsonb,updated_at=now() where server_id=$1 and id=any($2::uuid[])",[serverId,input.serviceIds,input.targetId,input.database,input.role,encryptSecret(input.password)])
    if(updated.rowCount!==input.serviceIds.length)throw new ApiError('A database link changed during the move',409)
    const c=(await client.query('select options from remote_storage_connections where server_id=$1 and id=$2 for update',[serverId,input.targetId])).rows[0]
    await client.query("update remote_storage_connections set options=jsonb_set(options,'{createdDatabases}',$3::jsonb) where server_id=$1 and id=$2",[serverId,input.targetId,JSON.stringify([...(c.options.createdDatabases||[]),{name:input.database,oid:result.oid}])])
    for(const app of input.apps){const saved=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,app.id])).rows[0],files=remoteEnvironmentFiles(saved);for(const [name,content]of Object.entries(files))files[name]=rewrite(content,input.connection,target).content;const effective={...parseEnvironmentText(files['.env']),...(saved.project_type==='laravel'?{}:parseEnvironmentText(files['.env.local']))};await client.query('update remote_apps set env_files_ciphertext=$3,env_ciphertext=$4,env_names=$5 where server_id=$1 and id=$2',[serverId,app.id,encryptSecret(JSON.stringify(files)),encryptSecret(JSON.stringify(effective)),Object.keys(effective).sort()]);await syncRemotePrimaryMetadata(client,serverId,app.id)}
  }
  await client.query('update remote_storage_changes set status=$2,error=null,finished_at=now() where id=$1',[row.id,result.accepted?'succeeded':'rolled_back'])
}
