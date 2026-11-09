import {createHash,randomBytes,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {decryptSecret,encryptSecret} from './secret-crypto'
import {ensureRemoteStorage,remoteStorageService,syncRemotePrimaryMetadata} from './remote-storage'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
import {remoteEnvironmentFiles} from './remote-environment'
import {parseEnvironmentText} from './environment-text'
import {databaseKey,parseDatabaseEnv} from './database-discovery-policy'
import {uuid} from './managed-servers'
import {hostKey,rewrite} from '../scripts/database-env-rewrite.cjs'

type Row=Record<string,any>
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const decode=(value:string)=>JSON.parse(decryptSecret(value))
async function prepare(client:PoolClient,serverId:string,id:string){
  const item=await remoteStorageService(client,serverId,id)
  if(item.provider!=='postgresql'||!item.provisioning_enabled||item.status!=='ready')throw new ApiError('Choose a verified PostgreSQL database with a saved administrator connection',409)
  const services=(await client.query(`select s.*,c.host,c.port,c.provider from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id and c.server_id=s.server_id where s.server_id=$1 order by s.id`,[serverId])).rows
  const matches=(d:Row)=>d.provider===item.provider&&hostKey(d.host)===hostKey(item.host)&&d.port===item.port&&d.database_name===item.database_name
  const linked=services.filter(matches)
  if(linked.some(s=>s.username!==item.username||s.status!=='ready'))throw new ApiError('Link this database with one verified application account before switching it',409)
  const apps=(await client.query('select * from remote_apps where server_id=$1 order by id for update',[serverId])).rows
  const ids=new Set(linked.map(s=>s.app_id)),key=databaseKey(item.provider,item.host,item.port,item.database_name)
  for(const app of apps){
    const uses=Object.entries(remoteEnvironmentFiles(app)).some(([file,content])=>parseDatabaseEnv(file,parseEnvironmentText(content)).some(d=>databaseKey(d.engine,d.host,d.port,d.database)===key))
    if(uses&&!ids.has(app.id))throw new ApiError(`Link ${app.name} to this database first so its settings switch too`,409)
  }
  const selected=apps.filter(a=>ids.has(a.id))
  if(!selected.length||selected.some(a=>!a.live_commit))throw new ApiError('Deploy each linked application before switching its live database settings',409)
  const input={action:'storage',operation:'dedicated-plan',serviceId:id,serverName:item.connection_name,
    connection:{provider:item.provider,host:item.host,port:item.port,database:item.database_name,username:item.username,password:decryptSecret(item.password_ciphertext),tls:item.tls_enabled},
    administrator:{provider:item.provider,host:item.host,port:item.port,database:'postgres',username:item.administrator,password:decryptSecret(item.administrator_ciphertext),tls:item.tls_enabled},
    apps:selected.map(a=>({id:a.id,name:a.name,commit:a.live_commit,serviceId:linked.find(s=>s.app_id===a.id).id})),serviceIds:linked.map(s=>s.id)}
  const metadataHash=hash({input,services:linked.map(s=>[s.id,s.app_id,s.connection_id,s.username,s.password_ciphertext,s.application_primary,s.options.ownership,s.options.injectEnv]),apps:selected.map(a=>[a.id,a.live_commit,a.project_type,a.env_ciphertext,a.env_files_ciphertext])})
  return{input,metadataHash}
}
export async function reviewRemoteDedicatedUser(serverId:string,id:string,actor:string){
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    await client.query("update remote_storage_changes c set status='needs_review',error='Verify the recorded agent outcome before making another database change.' from remote_jobs j where c.job_id=j.id and c.server_id=$1 and c.status='running' and j.status in ('failed','cancelled')",[serverId])
    const pending=(await client.query("select id,status,error from remote_storage_changes where server_id=$1 and service_id=$2 and kind='dedicated-user' and status in ('running','needs_review') order by created_at desc limit 1",[serverId,uuid(id)])).rows[0]
    if(pending)return{plan:null,recovery:pending}
    await admitResource(client,serverId)
    const {input,metadataHash}=await prepare(client,serverId,id),operationId=randomUUID(),payload={...input,operationId}
    await client.query("insert into remote_storage_changes(id,server_id,service_id,kind,metadata_hash,payload_ciphertext,created_by) values($1,$2,$3,'dedicated-user',$4,$5,$6)",[operationId,serverId,id,metadataHash,encryptSecret(JSON.stringify(payload)),actor])
    const job=await enqueueResource(client,serverId,payload,actor,id)
    await client.query('update remote_storage_changes set job_id=$2 where id=$1',[operationId,job.jobId]);return job
  })
}
export async function changeRemoteDedicatedUser(serverId:string,id:string,body:Row,actor:string){
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    const operationId=uuid(body.reconcile||body.review),row=(await client.query("select * from remote_storage_changes where id=$1 and server_id=$2 and service_id=$3 and kind='dedicated-user' for update",[operationId,serverId,uuid(id)])).rows[0]
    if(!row)throw new ApiError('Refresh the database checks before switching',409)
    await admitResource(client,serverId,operationId)
    let input=decode(row.payload_ciphertext)
    if(body.reconcile){
      if(row.status!=='needs_review')throw new ApiError('This database change does not need recovery',409)
      input={...input,operation:'dedicated-reconcile'}
    }else{
      if(body.confirm!==true)throw new ApiError('Acknowledge the application restarts first',400)
      if(row.status!=='preview'||Date.now()-Date.parse(row.created_at)>600000)throw new ApiError('The database review expired. Refresh the checks.',409)
      const current=await prepare(client,serverId,id),plan=decode(row.plan_private_ciphertext)
      if(current.metadataHash!==row.metadata_hash)throw new ApiError('The database links or application settings changed. Refresh the checks.',409)
      if(plan.blockers?.length)throw new ApiError(plan.blockers.join(' '),409)
      input={...input,operation:'dedicated-user',agentReview:plan.agentReview,role:plan.roleName,password:randomBytes(32).toString('base64url')}
    }
    const job=await enqueueResource(client,serverId,input,actor,id)
    await client.query("update remote_storage_changes set status='running',job_id=$2,payload_ciphertext=$3,error=null where id=$1",[row.id,job.jobId,encryptSecret(JSON.stringify(input))]);return job
  })
}
export async function finishRemoteStorageChange(client:PoolClient,serverId:string,resource:Row,success:boolean,result:Row|null){
  const row=(await client.query('select * from remote_storage_changes where server_id=$1 and id=$2 for update',[serverId,uuid(resource.operationId)])).rows[0]
  if(!row||row.service_id!==resource.serviceId)throw new ApiError('Database change receipt does not match its review',400)
  if(resource.operation==='dedicated-plan'){
    if(success&&(!result?.plan||result.plan.review!==row.id||!/^[a-f0-9]{64}$/.test(result.plan.agentReview)))throw new ApiError('Invalid database review receipt',400)
    await client.query('update remote_storage_changes set status=$2,plan_private_ciphertext=$3,finished_at=now() where id=$1',[row.id,success?'preview':'failed',success?encryptSecret(JSON.stringify(result!.plan)):null]);return
  }
  if(!success){await client.query("update remote_storage_changes set status='needs_review',error='The connection ended without a verified outcome. Reopen this database’s dedicated-user action and verify the agent journal.',finished_at=now() where id=$1",[row.id]);return}
  if(!result||result.operationId!==row.id||result.accepted!==true&&result.rolledBack!==true)throw new ApiError('Invalid database change acknowledgement',400)
  if(result.accepted){
    const input=decode(row.payload_ciphertext)
    if(result.role!==input.role||!Array.isArray(result.apps)||result.apps.length!==input.apps.length)throw new ApiError('Database switch acknowledgement changed the reviewed account or applications',400)
    const current=await prepare(client,serverId,row.service_id)
    if(current.metadataHash!==row.metadata_hash)throw new ApiError('Saved database settings changed during this operation. Reconcile before continuing.',409)
    const changed=await client.query("update remote_storage_services set username=$3,password_ciphertext=$4,pending_password_ciphertext=null,status='ready',options=options||'{\"ownership\":\"manager\"}'::jsonb,updated_at=now() where server_id=$1 and id=any($2::uuid[]) returning app_id",[serverId,input.serviceIds,input.role,encryptSecret(input.password)])
    if(changed.rowCount!==input.serviceIds.length)throw new ApiError('A database link changed during the switch',409)
    for(const app of input.apps){
      const returned=result.apps.find((a:Row)=>a.id===app.id)
      if(!returned||!Array.isArray(returned.files)||!Array.isArray(returned.keys)||returned.files.some((f:unknown)=>!['.env','.env.local','.env.production','.env.production.local'].includes(String(f)))||returned.keys.some((key:unknown)=>typeof key!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))throw new ApiError('Incomplete application environment receipt',400)
      const saved=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,app.id])).rows[0],files=remoteEnvironmentFiles(saved)
      // Keep the saved user environment distinct from agent-generated PORT,
      // HOST and process variables. Importing the live file would make the next
      // deployment reject its own generated variables as user overrides.
      for(const [file,content] of Object.entries(files))files[file]=rewrite(content,input.connection,{...input.connection,username:input.role,password:input.password}).content
      const effective={...parseEnvironmentText(files['.env']),...(saved.project_type==='laravel'?{}:parseEnvironmentText(files['.env.local']))}
      await client.query('update remote_apps set env_files_ciphertext=$3,env_ciphertext=$4,env_names=$5 where server_id=$1 and id=$2',[serverId,app.id,encryptSecret(JSON.stringify(files)),encryptSecret(JSON.stringify(effective)),Object.keys(effective).sort()])
      await syncRemotePrimaryMetadata(client,serverId,app.id)
    }
  }
  await client.query('update remote_storage_changes set status=$2,error=null,finished_at=now() where id=$1',[row.id,result.accepted?'succeeded':'rolled_back'])
}
