import {randomUUID,randomBytes} from 'node:crypto'
import {isIP} from 'node:net'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {query} from './db'
import {encryptSecret,decryptSecret} from './secret-crypto'
import {ensureManagedServers,uuid} from './managed-servers'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
import {remoteEnvironmentFiles} from './remote-environment'
import {environmentText,parseEnvironmentText} from './environment-text'
import {getNextRun,validateTimezone} from './cron-jobs'
import {parseServerDatabaseId} from './server-database-policy'

const hostKey=(value:string)=>['localhost','::1','[::1]'].includes(value)?'127.0.0.1':value.toLowerCase()
const text=(value:unknown,label:string,max=100)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new ApiError('Invalid '+label,400);return value.trim()}
const secret=(value:unknown)=>{if(typeof value!=='string'||!value||value.length>4096||/[\0\r\n]/.test(value))throw new ApiError('Provide a database password',400);return value}
const provider=(value:unknown)=>{if(!['postgresql','mysql','mariadb','sqlserver','mongodb','redis'].includes(String(value)))throw new ApiError('Unsupported database provider',400);return String(value)}
const decode=(value:string|null)=>value?decryptSecret(value):''
const publicConnection=`c.id,c.name,c.provider,c.host,c.port,c.username,c.tls_enabled,c.options,c.purpose,c.managed,c.is_default,c.provisioning_enabled,c.last_status,c.last_error,c.last_tested_at,c.created_at,c.updated_at`

/** Import only credentials Manager already owns; this never discovers or adopts unrelated databases. */
export async function ensureRemoteStorage(serverId:string){
  await ensureManagedServers();uuid(serverId)
  await resourceTransaction(serverId,async client=>{
    const installs=(await client.query("select id,service_id,credentials_ciphertext from remote_service_operations where server_id=$1 and status='success' and credentials_ciphertext is not null order by created_at",[serverId])).rows
    for(const item of installs){
      if(!['postgresql','mysql','mariadb','mongodb','sqlserver','redis'].includes(item.service_id))continue
      const d=JSON.parse(decryptSecret(item.credentials_ciphertext))
      if(!d.username||!d.password||!Number.isInteger(d.port))continue
      await client.query(`insert into remote_storage_connections(server_id,name,provider,host,port,username,password_ciphertext,managed,provisioning_enabled,last_status,source_operation_id)
        values($1,$2,$3,'127.0.0.1',$4,$5,$6,true,true,'healthy',$7) on conflict(source_operation_id) do nothing`,[serverId,`${item.service_id} · ${d.port} · ${item.id.slice(0,8)}`,item.service_id,d.port,d.username,encryptSecret(d.password),item.id])
    }
    const apps=(await client.query("select id,name,database_config,database_ciphertext from remote_apps where server_id=$1 and not storage_catalog_enabled and database_ciphertext is not null and database_config->>'status'='ready'",[serverId])).rows
    for(const app of apps){
      if((await client.query('select 1 from remote_storage_services where app_id=$1 and application_primary',[app.id])).rowCount)continue
      const d=JSON.parse(decryptSecret(app.database_ciphertext));let connection=(await client.query('select id from remote_storage_connections where server_id=$1 and provider=$2 and host=$3 and port=$4 order by provisioning_enabled desc,created_at limit 1',[serverId,d.provider,hostKey(d.host),d.port])).rows[0]
      if(!connection)connection=(await client.query(`insert into remote_storage_connections(server_id,name,provider,host,port,username,password_ciphertext,tls_enabled,options,last_status)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'healthy') returning id`,[serverId,`${app.name} · ${app.id.slice(0,8)}`,d.provider,hostKey(d.host),d.port,d.username,encryptSecret(d.password),d.tls===true,JSON.stringify({database:d.database})])).rows[0]
      await client.query(`insert into remote_storage_services(server_id,app_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,application_primary,options,status,legacy_app_id)
        values($1,$2,$3,'primary',$4,$5,$6,'PRIMARY',true,$7,'ready',$2) on conflict(legacy_app_id) do nothing`,[serverId,app.id,connection.id,d.database,d.username,encryptSecret(d.password),JSON.stringify({ownership:d.managed?'manager':'external'})])
      await client.query('update remote_apps set storage_catalog_enabled=true where id=$1 and server_id=$2',[app.id,serverId])
    }
  })
}
export async function remoteStorageConnections(serverId:string){
  await ensureRemoteStorage(serverId)
  return (await query(`select ${publicConnection},(select count(*)::int from remote_storage_services s where s.connection_id=c.id) as service_count from remote_storage_connections c where c.server_id=$1 order by c.name`,[serverId])).rows
}
export async function remoteStorageServices(serverId:string,appId?:string){
  await ensureRemoteStorage(serverId);if(appId)uuid(appId)
  if(appId&&!(await query('select 1 from remote_apps where server_id=$1 and id=$2',[serverId,appId])).rowCount)throw new ApiError('Application not found on this server',404)
  return (await query(`select s.id,s.app_id as project_id,a.name as project_name,a.environment_name as environment,a.application_group_id as group_id,
    s.name,s.database_name,s.username,s.env_prefix,s.application_primary,s.options,s.status,s.pending_password_ciphertext is not null as credential_recovery,s.connection_id,c.name as connection_name,c.provider,c.host,c.port,c.tls_enabled,
    case when s.status='pending' then 'Wait for the database operation to finish'
      when exists(select 1 from remote_storage_changes c where c.server_id=s.server_id and c.kind='migration' and (c.service_id=s.id or c.target_service_id=s.id)) then 'Remove this service’s migration history first. Database data will be preserved.'
      else null end as removal_blocked_reason,
    b.last_status as backup_status
    from remote_storage_services s join remote_apps a on a.id=s.app_id and a.server_id=s.server_id join remote_storage_connections c on c.id=s.connection_id and c.server_id=s.server_id
    left join remote_storage_schedules b on b.service_id=s.id where s.server_id=$1 and ($2::uuid is null or s.app_id=$2) order by s.created_at`,[serverId,appId||null])).rows
}
export async function remoteStorageService(client:PoolClient,serverId:string,id:string){
  const raw=parseServerDatabaseId(id)
  if(raw){
    const c=(await client.query("select * from remote_storage_connections where server_id=$1 and id=$2 and provider='postgresql' and provisioning_enabled for update",[serverId,uuid(raw.connectionId)])).rows[0]
    if(!c)throw new ApiError('PostgreSQL administrator connection not found on this server',404)
    if(!raw.database||Buffer.byteLength(raw.database)>63||/[\0\r\n]/.test(raw.database))throw new ApiError('Invalid database name',400)
    return{...c,id,connection_id:c.id,connection_name:c.name,database_name:raw.database,administrator:c.username,administrator_ciphertext:c.password_ciphertext,options:{ownership:'external',untracked:true},status:'ready'}
  }
  const row=(await client.query(`select s.*,c.provider,c.host,c.port,c.tls_enabled,c.name as connection_name,c.username as administrator,c.password_ciphertext as administrator_ciphertext,c.provisioning_enabled
    from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id and c.server_id=s.server_id where s.server_id=$1 and s.id=$2 for update of s`,[serverId,uuid(id)])).rows[0]
  if(!row)throw new ApiError('Database not found on this server',404)
  return row
}
const service=remoteStorageService
export async function remoteStorageDetail(serverId:string,id:string){
  const services=await remoteStorageServices(serverId),selected=services.find(s=>s.id===uuid(id));if(!selected)throw new ApiError('Database not found on this server',404)
  const linked=services.filter(s=>s.provider===selected.provider&&hostKey(s.host)===hostKey(selected.host)&&s.port===selected.port&&s.database_name===selected.database_name)
  const stats=selected.options.stats,backups=selected.options.backups||[]
  const schedule=(await query('select * from remote_storage_schedules where server_id=$1 and service_id=$2',[serverId,id])).rows[0]
  return{id,database:selected.database_name,engine:selected.provider,serverId:selected.connection_id,serverName:selected.connection_name,serverRole:'apps',host:selected.host,port:selected.port,sizeBytes:stats?.sizeBytes??null,tableCount:stats?.tableCount??null,ownership:selected.options.ownership||'external',warnings:selected.status==='ready'?[]:['The saved database credential has not passed its connection test.'],apps:linked.map(s=>({serviceId:s.id,projectId:s.project_id,name:s.project_name,environment:s.environment,groupId:s.group_id,groupName:null,ownership:s.options.ownership||'external',username:s.username})),backup:schedule?{...schedule.config,scheduleId:schedule.id,lastStatus:schedule.last_status,lastFinishedAt:schedule.last_finished_at,nextRunAt:schedule.next_run_at}:null,backups}
}
const name=(value:unknown,label:string,max=63)=>{const result=text(value,label,max);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result))throw new ApiError(`${label} must use letters, numbers and underscores`,400);return result}
const password=()=>randomBytes(30).toString('base64url')
async function idle(client:PoolClient,serverId:string){if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running') union all select 1 from remote_storage_renames where server_id=$1 and status in ('running','needs_review') union all select 1 from remote_storage_changes where server_id=$1 and status in ('running','needs_review')",[serverId])).rowCount)throw new ApiError('Finish the current server operation or verify the pending database change first',409)}
async function application(client:PoolClient,serverId:string,id:string){const app=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,uuid(id)])).rows[0];if(!app)throw new ApiError('Application not found on this server',404);return app}
const credential=(item:Record<string,any>)=>({provider:item.provider,host:item.host,port:item.port,username:item.username,password:decode(item.password_ciphertext),database:item.database_name,tls:item.tls_enabled})
const administrator=(item:Record<string,any>)=>({provider:item.provider,host:item.host,port:item.port,username:item.administrator,password:decode(item.administrator_ciphertext),database:'postgres',tls:item.tls_enabled})
function backupCredential(item:Record<string,any>,config:Record<string,any>|undefined){if(config?.credentialSource==='connection'){if(!item.provisioning_enabled||!item.administrator_ciphertext)throw new ApiError('Save a PostgreSQL administrator connection before using it for backups',409);return{...administrator(item),database:item.database_name}}return credential(item)}
export function remoteStorageUrl(item:Record<string,any>,secretValue:string){
  const host=isIP(item.host)===6?`[${item.host}]`:item.host,auth=item.username?`${encodeURIComponent(item.username)}:${encodeURIComponent(secretValue)}@`:secretValue?`:${encodeURIComponent(secretValue)}@`:''
  const protocol=item.provider==='mariadb'?'mysql':item.provider==='redis'&&item.tls_enabled?'rediss':item.provider
  return `${protocol}://${auth}${host}:${item.port}/${encodeURIComponent(item.database_name)}${item.provider==='postgresql'?`?sslmode=${item.tls_enabled?'verify-full':'disable'}`:''}`
}
export function remoteServiceEnvironment(item:Record<string,any>,projectType:string){
  if(item.options?.ownership==='adopted'||item.options?.injectEnv===false)return{}
  const secretValue=decode(item.password_ciphertext),url=remoteStorageUrl(item,secretValue),env:Record<string,string>={}
  if(!item.application_primary){const prefix=item.env_prefix;return{[`${prefix}_URL`]:url,[`${prefix}_HOST`]:item.host,[`${prefix}_PORT`]:String(item.port),[`${prefix}_DATABASE`]:item.database_name,...(item.username?{[`${prefix}_USER`]:item.username}:{}),...(secretValue?{[`${prefix}_PASSWORD`]:secretValue}:{})}}
  if(['node','next'].includes(projectType))Object.assign(env,{DATABASE_URL:url,DATABASE_HOST:item.host,DATABASE_PORT:String(item.port),DATABASE_NAME:item.database_name,DATABASE_USER:item.username||'',DATABASE_PASSWORD:secretValue})
  if(projectType==='laravel'&&['postgresql','mysql','mariadb','sqlserver'].includes(item.provider))Object.assign(env,{DB_CONNECTION:item.provider==='postgresql'?'pgsql':item.provider==='sqlserver'?'sqlsrv':'mysql',DB_HOST:item.host,DB_PORT:String(item.port),DB_DATABASE:item.database_name,DB_USERNAME:item.username||'',DB_PASSWORD:secretValue})
  if(projectType==='go')Object.assign(env,{DATABASE_URL:url,DB_DRIVER:item.provider==='postgresql'?'postgres':item.provider,DB_HOST:item.host,DB_PORT:String(item.port),DB_NAME:item.database_name,DB_USER:item.username||'',DB_PASSWORD:secretValue})
  if(item.provider==='mongodb')env.MONGODB_URI=url;if(item.provider==='redis')env.REDIS_URL=url
  return env
}
export async function remoteStorageEnvironment(client:PoolClient,serverId:string,app:{id:string;project_type:string}){
  const rows=(await client.query('select s.*,c.provider,c.host,c.port,c.tls_enabled from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id and c.server_id=s.server_id where s.server_id=$1 and s.app_id=$2 order by s.created_at',[serverId,app.id])).rows
  if(rows.some(s=>s.status!=='ready'))throw new ApiError('Test or disconnect the application database that is not ready before deploying',409)
  return Object.assign({},...rows.filter(s=>s.status==='ready').map(s=>remoteServiceEnvironment(s,app.project_type))) as Record<string,string>
}
export async function syncRemotePrimaryMetadata(client:PoolClient,serverId:string,appId:string){
  const item=(await client.query('select s.*,c.provider,c.host,c.port,c.tls_enabled from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and s.app_id=$2 and s.application_primary',[serverId,appId])).rows[0]
  const config=item?{provider:item.provider,host:item.host,port:item.port,database:item.database_name,username:item.username,tls:item.tls_enabled,managed:item.options.ownership==='manager',mode:'existing',status:item.status}:null
  await client.query("update remote_apps set database_config=$3,database_ciphertext=$4,setup_decisions=setup_decisions||jsonb_build_object('database',$5::text) where server_id=$1 and id=$2",[serverId,appId,config?JSON.stringify(config):null,config?encryptSecret(JSON.stringify({...config,password:decode(item.password_ciphertext)})):null,config?item.status==='ready'?'configured':'pending':'none'])
}
const syncPrimaryMetadata=syncRemotePrimaryMetadata
export async function createRemoteStorageConnection(serverId:string,body:Record<string,unknown>,actor:string){
  const engine=provider(body.provider),host=text(body.host,'database host',253),port=Number(body.port)
  if(!isIP(host)&&!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))throw new ApiError('Use a hostname or IP address',400)
  if(!Number.isInteger(port)||port<1||port>65535)throw new ApiError('Invalid database port',400)
  if(!['shared_application','dedicated_application','external_service'].includes(String(body.purpose||'shared_application')))throw new ApiError('Invalid connection purpose',400)
  // Other providers use the same registered-connection form; their driver adapter
  // must be present before credentials can be accepted as healthy.
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const id=randomUUID()
    if(body.isDefault===true)await client.query('update remote_storage_connections set is_default=false where server_id=$1 and provider=$2',[serverId,engine])
    await client.query(`insert into remote_storage_connections(id,server_id,name,provider,host,port,username,password_ciphertext,tls_enabled,purpose,is_default,provisioning_enabled,created_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,serverId,text(body.name,'connection name'),engine,hostKey(host),port,engine==='redis'&&!body.username?'':text(body.username,'database administrator',128),encryptSecret(engine==='redis'&&!body.password?'':secret(body.password)),body.tlsEnabled===true,body.purpose||'shared_application',body.isDefault===true,body.provisioningEnabled===true,actor])
    return queueConnectionTest(client,serverId,id,actor)
  })
}
async function queueConnectionTest(client:PoolClient,serverId:string,id:string,actor:string){
  const item=(await client.query('select * from remote_storage_connections where server_id=$1 and id=$2',[serverId,uuid(id)])).rows[0];if(!item)throw new ApiError('Connection not found on this server',404)
  return enqueueResource(client,serverId,{action:'storage',operation:'test',connectionId:id,serviceId:id,connection:{...credential(item),database:String(item.options.database||({postgresql:'postgres',mysql:'mysql',mariadb:'mysql',sqlserver:'master',mongodb:'admin',redis:'0'} as Record<string,string>)[item.provider])}},actor,id)
}
export async function changeRemoteStorageConnection(serverId:string,id:string,remove:boolean,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    if(remove){await idle(client,serverId);if((await client.query('select 1 from remote_storage_services where server_id=$1 and connection_id=$2',[serverId,uuid(id)])).rowCount)throw new ApiError('Disconnect this server’s application databases first. Data and database accounts are preserved.',409);if(!(await client.query('delete from remote_storage_connections where server_id=$1 and id=$2',[serverId,id])).rowCount)throw new ApiError('Connection not found',404);return{ok:true}}
    await admitResource(client,serverId);return queueConnectionTest(client,serverId,id,actor)
  })
}
export async function createRemoteStorageService(serverId:string,appId:string,body:Record<string,unknown>,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const app=await application(client,serverId,appId);if(app.project_type==='angular')throw new ApiError('Connect databases to a backend application',400)
    const id=randomUUID();let item,options:Record<string,unknown>,serviceName:string,dbName:string,username:string,secretValue:string
    if(body.mode==='shared'){
      const source=await service(client,serverId,String(body.sourceServiceId));const sourceApp=await application(client,serverId,source.app_id)
      if(source.app_id===appId||!app.application_group_id||app.application_group_id!==sourceApp.application_group_id||app.environment_name!==sourceApp.environment_name||source.status!=='ready')throw new ApiError('Share only a verified database within this project and environment',409)
      item={id:source.connection_id,...source};serviceName=source.name;dbName=source.database_name;username=source.username;secretValue=decode(source.password_ciphertext);options={ownership:'shared',sharedFrom:source.id}
    }else{
      if(!['existing','provision'].includes(String(body.mode)))throw new ApiError('Choose a database action',400)
      item=(await client.query('select * from remote_storage_connections where server_id=$1 and id=$2',[serverId,uuid(body.connectionId)])).rows[0];if(!item)throw new ApiError('Connection not found on this server',404)
      if(body.mode==='provision'&&(!item.provisioning_enabled||item.purpose==='external_service'||item.last_status!=='healthy'))throw new ApiError('Test a provisioning connection before creating a database',409)
      serviceName=name(body.name||'primary','service name',40);dbName=item.provider==='redis'?String(body.databaseName||'0'):(body.mode==='existing'?text:name)(body.databaseName||`app_${appId.replaceAll('-','').slice(0,12)}_${serviceName}`,'database name');username=item.provider==='redis'?String(body.username||item.username||''):(body.mode==='existing'?text:name)(body.username||`app_${id.replaceAll('-','').slice(0,20)}`,'database user',item.provider==='mysql'||item.provider==='mariadb'?32:63);secretValue=body.password?secret(body.password):item.provider==='redis'?decode(item.password_ciphertext):body.mode==='provision'?password():secret(body.password);options={ownership:body.mode==='provision'&&item.provider!=='redis'?'manager':'external'}
      if(item.provider==='redis'&&(!/^\d{1,2}$/.test(dbName)||Number(dbName)>15))throw new ApiError('Redis database must be between 0 and 15',400)
    }
    const prefix=name(body.envPrefix||serviceName.toUpperCase(),'environment prefix',40).toUpperCase();options.pendingPrimary=body.applicationPrimary===true;options.backupEnabled=item.provider==='postgresql'&&body.backupEnabled===true
    await client.query(`insert into remote_storage_services(id,server_id,app_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,options,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,serverId,appId,item.connection_id||item.id,serviceName,dbName,username,encryptSecret(secretValue),prefix,JSON.stringify(options),actor])
    await client.query('update remote_apps set storage_catalog_enabled=true where server_id=$1 and id=$2',[serverId,appId])
    const connection={provider:item.provider,host:item.host,port:item.port,tls:item.tls_enabled,database:dbName,username,password:secretValue}
    return enqueueResource(client,serverId,{action:'storage',serviceId:id,operation:body.mode==='provision'&&item.provider!=='redis'?'provision':'test',connection,...(body.mode==='provision'?{administrator:{...connection,username:item.username,password:decode(item.password_ciphertext),database:item.provider==='postgresql'?'postgres':item.provider==='sqlserver'?'master':'admin'}}:{})},actor,id)
  })
}
export async function changeRemoteStorageService(serverId:string,appId:string,id:string,remove:boolean,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await idle(client,serverId);const app=await application(client,serverId,appId),item=await service(client,serverId,id);if(item.app_id!==appId)throw new ApiError('Database not found in this application',404)
    if(remove){
      if((await client.query("select 1 from remote_storage_changes where server_id=$1 and kind='migration' and (service_id=$2 or target_service_id=$2) and status not in ('reviewing','preview','preview_failed')",[serverId,id])).rowCount)throw new ApiError('Finish or verify the linked migrations, then remove their history records before disconnecting this database',409)
      if((await client.query("select 1 from remote_storage_services where server_id=$1 and options->>'sharedFrom'=$2",[serverId,id])).rowCount)throw new ApiError('Disconnect the other applications sharing this database first',409)
      // Preserve its current effective values for the next deploy as well as the
      // running release. Removing tracking never deletes the underlying database.
      const values=item.status==='ready'?remoteServiceEnvironment(item,app.project_type):{},files=remoteEnvironmentFiles(app),environment={...JSON.parse(decryptSecret(app.env_ciphertext)),...values}
      for(const file of ['.env','.env.local']){const retained=files[file].split(/\r?\n/).filter(line=>!Object.keys(values).some(key=>new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line.trimStart()))).join('\n');files[file]=retained+(file==='.env'||app.project_type!=='laravel'?'\n'+environmentText(values)+'\n':'')}
      await client.query('update remote_apps set env_ciphertext=$3,env_files_ciphertext=$4,env_names=$5,storage_catalog_enabled=true where server_id=$1 and id=$2',[serverId,appId,encryptSecret(JSON.stringify(environment)),encryptSecret(JSON.stringify(files)),Object.keys(environment).sort()])
      await client.query('delete from remote_storage_services where server_id=$1 and id=$2',[serverId,id])
    }else{if(item.status!=='ready')throw new ApiError('Test this database before selecting it',409);await client.query('update remote_storage_services set application_primary=false where server_id=$1 and app_id=$2',[serverId,appId]);await client.query('update remote_storage_services set application_primary=true where server_id=$1 and id=$2',[serverId,id])}
    await syncPrimaryMetadata(client,serverId,appId)
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,remove?'remote.storage.disconnect':'remote.storage.primary',id,JSON.stringify({serverId,appId,preservedDatabase:true})]);return{ok:true}
  })
}
export async function syncRemoteStorageEnvironment(serverId:string,appId:string,body:Record<string,unknown>,actor:string){
  if(body.file!=='.env')throw new ApiError('Database sync writes the application .env file',400)
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await idle(client,serverId);const app=await application(client,serverId,appId),environment=await remoteStorageEnvironment(client,serverId,app),files=remoteEnvironmentFiles(app),current={...parseEnvironmentText(files['.env']),...parseEnvironmentText(files['.env.local'])}
    const primary=(await client.query(`select s.database_name,c.provider from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and s.app_id=$2 and s.application_primary`,[serverId,appId])).rows[0]||null
    const keys=Object.keys(environment),changesApplicationDatabase=['DATABASE_URL','DB_HOST','DB_PORT','DB_DATABASE','DB_NAME','DB_CONNECTION','MONGODB_URI','REDIS_URL'].some(key=>environment[key]&&current[key]&&environment[key]!==current[key])
    const runtimeBlockers=app.live_commit?[]:['Deploy this application first. Its saved database credentials will be injected into that deployment.']
    if(body.preview===true)return{keys,changesApplicationDatabase,activeService:primary,runtimeBlockers}
    if(runtimeBlockers.length)throw new ApiError(runtimeBlockers[0],409)
    if(changesApplicationDatabase&&body.confirmApplicationChange!==true)throw new ApiError('Review and confirm the database change first',409)
    if(!keys.length)throw new ApiError('There are no managed database variables to sync',409)
    await admitResource(client,serverId)
    files['.env']=files['.env'].split(/\r?\n/).filter(line=>!keys.some(key=>new RegExp(`^(?:export\\s+)?${key}\\s*=`).test(line.trimStart()))).join('\n')+'\n'+environmentText(environment)+'\n'
    const effective={...parseEnvironmentText(files['.env']),...(app.project_type==='laravel'?{}:parseEnvironmentText(files['.env.local']))}
    return enqueueResource(client,serverId,{action:'storage',operation:'sync-env',serviceId:appId,environment,files,effective,restart:body.restart!==false},actor,appId)
  })
}
export async function remoteStorageOperation(serverId:string,id:string,operation:string,body:Record<string,unknown>,actor:string){
  if(!['overview','stats','tables','rows','sql','backups','backup','test','restore','rotate','test-proposed'].includes(operation))throw new ApiError('Unknown database operation',400)
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId);const item=await service(client,serverId,id)
    if(parseServerDatabaseId(id)&&!['tables','rows','sql'].includes(operation))throw new ApiError('Link this database to an application before managing credentials and backups',409)
    if(item.provider!=='postgresql'&&!['test','test-proposed','rotate'].includes(operation))throw new ApiError('These explorer and backup controls require PostgreSQL, as on the Manager host',409)
    const connection=credential(item)
    if(operation==='test-proposed'){if(!item.pending_password_ciphertext)throw new ApiError('There is no interrupted password change to recover',409);connection.password=decode(item.pending_password_ciphertext)}
    if(['restore','rotate'].includes(operation)&&!item.provisioning_enabled)throw new ApiError('Save and test a database administrator connection before this action',409)
    if(operation==='rotate'&&item.options.ownership!=='manager')throw new ApiError('Rotate only an application account created by Manager. Existing accounts are preserved.',409)
    if(operation==='rotate'&&secret(body.password).length<12)throw new ApiError('Use a password of at least 12 characters',400)
    if(operation==='restore'&&(typeof body.file!=='string'||!item.options.backups?.some((backup:Record<string,unknown>)=>backup.file===body.file)))throw new ApiError('Refresh and choose a recorded backup',409)
    if(operation==='sql'&&(typeof body.sql!=='string'||!body.sql.trim()||body.sql.length>50000||body.sql.includes('\0')))throw new ApiError('SQL must contain 1–50000 characters',400)
    const schedule=operation==='backup'?(await client.query('select config from remote_storage_schedules where server_id=$1 and service_id=$2',[serverId,id])).rows[0]:null
    if(operation==='backup')Object.assign(connection,backupCredential(item,schedule?.config))
    const input={action:'storage',operation,serviceId:id,connection,...(['restore','rotate'].includes(operation)?{administrator:administrator(item)}:{}),...(operation==='rotate'?{password:secret(body.password)}:{}),...(operation==='restore'?{file:body.file,targetDatabase:item.database_name.slice(0,36)+'_restore_'+randomUUID().replaceAll('-','').slice(0,12)}:{}),...(operation==='backup'?{retentionCount:schedule?.config.retentionCount}:{}),...(operation==='sql'?{sql:body.sql,allowWrites:body.allowWrites===true}:{}),...(operation==='rows'?{schema:text(body.schema,'schema',63),table:text(body.table,'table',63),page:Number(body.page)||1,pageSize:Number(body.pageSize)||50}:{})}
    const job=await enqueueResource(client,serverId,operation==='test-proposed'?{...input,operation:'test',credentialRecovery:true}:input,actor,parseServerDatabaseId(id)?.connectionId||id)
    if(operation==='rotate')await client.query(`update remote_storage_services s set pending_password_ciphertext=$6,status='pending' from remote_storage_connections c where c.id=s.connection_id and c.server_id=s.server_id and s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username,encryptSecret(secret(body.password))])
    if(operation==='backup')await client.query("update remote_storage_schedules set last_status='running',last_job_id=$3 where server_id=$1 and service_id=$2",[serverId,id,job.jobId])
    return job
  })
}
export async function finishStorageOperation(client:PoolClient,serverId:string,job:{id:string;resource_target:string},payload:Record<string,any>,success:boolean,result:Record<string,any>|null){
  const resource=payload.resource
  if((parseServerDatabaseId(resource?.serviceId||'')?.connectionId||resource?.serviceId)!==job.resource_target)throw new ApiError('Database receipt does not match this operation',400)
  if(['migration-preview','migration-run','migration-reconcile'].includes(resource.operation)){await(await import('./remote-storage-migrations')).finishRemoteMigration(client,serverId,resource,success,result);return}
  if(['dedicated-plan','dedicated-user','dedicated-reconcile'].includes(resource.operation)){await(await import('./remote-storage-changes')).finishRemoteStorageChange(client,serverId,resource,success,result);return}
  if(['move-plan','move','move-reconcile'].includes(resource.operation)){await(await import('./remote-storage-move')).finishRemoteStorageMove(client,serverId,resource,success,result);return}
  if(['inventory','server-create','server-drop','restrict'].includes(resource.operation)){await(await import('./remote-storage-servers')).finishRemoteStorageServerOperation(client,serverId,resource,success,result);return}
  if(parseServerDatabaseId(resource.serviceId)&&['tables','rows','sql','rename-plan'].includes(resource.operation))return
  if(['rename','rename-reconcile'].includes(resource.operation)){await(await import('./remote-storage-rename')).finishRemoteStorageRename(client,serverId,resource,success,result);return}
  if(resource.operation==='sync-env'){
    if(success){
      if(result?.synced!==true||JSON.stringify([...result.keys||[]].sort())!==JSON.stringify(Object.keys(resource.environment).sort()))throw new ApiError('Invalid database environment receipt',400)
      await client.query('update remote_apps set env_files_ciphertext=$3,env_ciphertext=$4,env_names=$5 where server_id=$1 and id=$2',[serverId,job.resource_target,encryptSecret(JSON.stringify(resource.files)),encryptSecret(JSON.stringify(resource.effective)),Object.keys(resource.effective).sort()])
    }
    return
  }
  if(resource.connectionId){
    if(resource.connectionId!==job.resource_target||resource.operation!=='test'||success&&result?.connected!==true)throw new ApiError('Invalid connection receipt',400)
    await client.query('update remote_storage_connections set last_status=$3,last_error=$4,last_tested_at=now() where server_id=$1 and id=$2',[serverId,job.resource_target,success?'healthy':'failed',success?null:'Connection test failed on the selected server']);return
  }
  const item=await service(client,serverId,job.resource_target)
  if(['test','provision'].includes(resource.operation)){
    if(success&&result?.connected!==true)throw new ApiError('Invalid credential receipt',400)
    await client.query('update remote_storage_services set status=$3,updated_at=now() where server_id=$1 and id=$2',[serverId,item.id,success?'ready':item.pending_password_ciphertext?'needs_review':'failed'])
    if(success&&item.pending_password_ciphertext){
      if(resource.credentialRecovery===true&&resource.connection.password!==decode(item.pending_password_ciphertext))throw new ApiError('Password recovery changed before completion',409)
      await client.query(`update remote_storage_services s set password_ciphertext=$6,pending_password_ciphertext=null,status='ready',updated_at=now() from remote_storage_connections c where c.id=s.connection_id and c.server_id=s.server_id and s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username,encryptSecret(resource.connection.password)])
      const affected=(await client.query(`select distinct s.app_id from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username])).rows
      for(const app of affected)await syncPrimaryMetadata(client,serverId,app.app_id)
    }
    if(success&&item.options.pendingPrimary){await client.query('update remote_storage_services set application_primary=false where server_id=$1 and app_id=$2',[serverId,item.app_id]);await client.query("update remote_storage_services set application_primary=true,options=options-'pendingPrimary' where server_id=$1 and id=$2",[serverId,item.id])}
    if(success&&item.options.backupEnabled){const config=backupConfig({});await client.query('insert into remote_storage_schedules(server_id,service_id,config,next_run_at) values($1,$2,$3,$4) on conflict(service_id) do nothing',[serverId,item.id,JSON.stringify(config),nextBackup(config)])}
    await syncPrimaryMetadata(client,serverId,item.app_id)
  }
  if(success&&resource.operation==='rotate'){
    if(result?.rotated!==true||result?.connected!==true)throw new ApiError('Invalid password change receipt',400)
    await client.query(`update remote_storage_services s set password_ciphertext=$6,pending_password_ciphertext=null,status='ready',updated_at=now() from remote_storage_connections c where c.id=s.connection_id and c.server_id=s.server_id and s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username,encryptSecret(resource.password)])
    const apps=(await client.query(`select distinct s.app_id from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username])).rows
    for(const app of apps)await syncPrimaryMetadata(client,serverId,app.app_id)
  }
  if(!success&&resource.operation==='rotate')await client.query(`update remote_storage_services s set status='needs_review' from remote_storage_connections c where c.id=s.connection_id and c.server_id=s.server_id and s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.username=$5`,[serverId,item.provider,item.host,item.port,item.username])
  if(success&&result){
    let cache:Record<string,unknown>|null=null
    if(['stats','overview'].includes(resource.operation)){
      if(!Number.isFinite(result.sizeBytes)||result.sizeBytes<0||!Number.isInteger(result.tableCount)||result.tableCount<0)throw new ApiError('Invalid database statistics',400)
      cache={stats:{sizeBytes:result.sizeBytes,tableCount:result.tableCount,checkedAt:new Date().toISOString()}}
    }
    if(['backups','backup','overview'].includes(resource.operation)){
      if(!Array.isArray(result.backups)||result.backups.length>365||result.backups.some((b:Record<string,any>)=>typeof b.file!=='string'||!/^[0-9TZ-]+-[a-f0-9-]{36}\.dump$/.test(b.file)||b.serviceId!==resource.serviceId||!Number.isFinite(b.sizeBytes)||b.sizeBytes<0||!Number.isFinite(Date.parse(b.createdAt))))throw new ApiError('Invalid backup receipt',400)
      cache={...cache,backups:result.backups}
    }
    if(cache)await client.query('update remote_storage_services set options=options||$3::jsonb,updated_at=now() where server_id=$1 and id=$2',[serverId,job.resource_target,JSON.stringify(cache)])
    if(resource.operation==='test')await client.query("update remote_storage_services set status='ready',updated_at=now() where server_id=$1 and id=$2",[serverId,job.resource_target])
  }
  if(resource.operation==='backup')await client.query('update remote_storage_schedules set last_status=$3,last_finished_at=now() where server_id=$1 and service_id=$2',[serverId,job.resource_target,success?'success':'failed'])
}
export function backupConfig(body:Record<string,unknown>){
  const frequency=String(body.frequency||'daily'),timeOfDay=String(body.timeOfDay||'03:00'),timezone=String(body.timezone||'UTC'),dayOfWeek=Number(body.dayOfWeek??0),dayOfMonth=Number(body.dayOfMonth??1),monthOfYear=Number(body.monthOfYear??1),retentionCount=Number(body.retentionCount??30)
  if(!['daily','weekly','monthly','yearly'].includes(frequency)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay)||!validateTimezone(timezone)||!Number.isInteger(dayOfWeek)||dayOfWeek<0||dayOfWeek>6||!Number.isInteger(dayOfMonth)||dayOfMonth<1||dayOfMonth>28||!Number.isInteger(monthOfYear)||monthOfYear<1||monthOfYear>12||!Number.isInteger(retentionCount)||retentionCount<1||retentionCount>365)throw new ApiError('Invalid backup schedule',400)
  const credentialSource=String(body.credentialSource||'application');if(!['application','connection'].includes(credentialSource))throw new ApiError('Choose the application or managed connection backup account',400)
  return{frequency,timeOfDay,timezone,dayOfWeek,dayOfMonth,monthOfYear,retentionCount,credentialSource,enabled:body.enabled!==false}
}
function nextBackup(config:ReturnType<typeof backupConfig>){const [hour,minute]=config.timeOfDay.split(':').map(Number);return config.enabled?getNextRun(`${minute} ${hour} ${['monthly','yearly'].includes(config.frequency)?config.dayOfMonth:'*'} ${config.frequency==='yearly'?config.monthOfYear:'*'} ${config.frequency==='weekly'?config.dayOfWeek:'*'}`,config.timezone):null}
export async function saveRemoteStorageSchedule(serverId:string,body:Record<string,unknown>,actor:string){
  const config=backupConfig(body);await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{const item=await service(client,serverId,String(body.serviceId));if(item.provider!=='postgresql'||item.status!=='ready')throw new ApiError('Backups require a verified PostgreSQL application connection',409);backupCredential(item,config);await idle(client,serverId);const schedule=(await client.query('insert into remote_storage_schedules(server_id,service_id,config,next_run_at) values($1,$2,$3,$4) on conflict(service_id) do update set config=$3,next_run_at=$4 returning id',[serverId,item.id,JSON.stringify(config),nextBackup(config)])).rows[0];await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.storage.backup-schedule',item.id,JSON.stringify({serverId,config})]);return{schedule:{id:schedule.id,...config}}})
}
export async function remoteStorageSchedulerTick(){
  await ensureManagedServers()
  await query("update remote_storage_schedules s set last_status=j.status,last_finished_at=j.finished_at from remote_jobs j where s.last_job_id=j.id and s.server_id=j.server_id and s.last_status='running' and j.status not in ('queued','running')")
  const due=(await query("select b.id,b.server_id,b.service_id from remote_storage_schedules b join managed_servers s on s.id=b.server_id where b.next_run_at<=now() and b.config->>'enabled'='true' and s.enabled and s.last_seen_at>now()-interval '90 seconds' order by b.next_run_at limit 10")).rows
  for(const candidate of due)try{await resourceTransaction(candidate.server_id,async client=>{
    await admitResource(client,candidate.server_id);const schedule=(await client.query('select * from remote_storage_schedules where server_id=$1 and id=$2 and next_run_at<=now() for update',[candidate.server_id,candidate.id])).rows[0];if(!schedule)return
    const item=await service(client,candidate.server_id,candidate.service_id);if(item.status!=='ready')return
    const job=await enqueueResource(client,candidate.server_id,{action:'storage',operation:'backup',serviceId:item.id,connection:backupCredential(item,schedule.config),retentionCount:schedule.config.retentionCount},null,item.id)
    await client.query("update remote_storage_schedules set next_run_at=$2,last_job_id=$3,last_status='running' where id=$1",[schedule.id,nextBackup(schedule.config),job.jobId])
  })}catch(error){if(!(error instanceof ApiError&&error.status===409))console.error('[Remote storage schedule]',(error as Error).message)}
}
