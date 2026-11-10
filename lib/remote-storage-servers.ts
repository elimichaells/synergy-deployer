import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {ApiError} from './api'
import {query} from './db'
import {decryptSecret} from './secret-crypto'
import {uuid} from './managed-servers'
import {ensureRemoteStorage,remoteStorageConnections,remoteStorageServices} from './remote-storage'
import {discoverRemoteStorage} from './remote-storage-discovery'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'
import {serverDatabaseId} from './server-database-policy'
import {remoteEnvironmentFiles} from './remote-environment'
import {parseEnvironmentText} from './environment-text'
import {parseDatabaseEnv,databaseKey} from './database-discovery-policy'

const physical=(host:string)=>['localhost','::1','[::1]'].includes(host)?'127.0.0.1':host.toLowerCase()
const connection=(c:Record<string,any>)=>({provider:c.provider,host:c.host,port:c.port,username:c.username,password:c.password_ciphertext?decryptSecret(c.password_ciphertext):'',database:'postgres',tls:c.tls_enabled})
async function detachedRecords(client:Pick<PoolClient,'query'>,serverId:string){return(await client.query('select name,record_ciphertext from removed_application_records where server_id=$1',[serverId])).rows.map(row=>({name:row.name,record:JSON.parse(decryptSecret(row.record_ciphertext))}))}
function detachedUsage(records:{name:string;record:Record<string,any>}[],c:Record<string,any>,database:string){
  const matches=(d:Record<string,any>)=>databaseKey(d.provider||d.engine,d.host,d.port,d.database_name||d.database)===databaseKey(c.provider,c.host,c.port,database)
  return records.filter(({record})=>record.connections?.some((d:Record<string,any>)=>d.database_name===database&&(d.connection_id===c.id||d.host&&matches(d)))||record.app?.database_config&&matches(record.app.database_config)||Object.entries(remoteEnvironmentFiles(record.app||{})).some(([file,content])=>parseDatabaseEnv(file,parseEnvironmentText(content)).some(matches))).map(row=>row.name+' (management removed)')
}
export async function remoteStorageEngines(serverId:string){
  const connections=await remoteStorageConnections(serverId)
  return connections.map(c=>{const inventory=c.options.inventory;return{id:c.id,name:c.name,engine:c.provider,host:c.host,port:c.port,role:c.purpose==='external_service'?'external':'apps',provisioning:c.provisioning_enabled,status:c.last_status,version:inventory?.version??null,listen:inventory?.listen??null,localOnly:inventory?.localOnly??null,remoteRules:inventory?.remoteRules??null,ssl:inventory?.ssl??null,pendingRestart:inventory?.pendingRestart===true,databaseCount:inventory?.databases?.length??null,sizeBytes:inventory?.databases?.reduce((sum:number,d:{sizeBytes:number})=>sum+d.sizeBytes,0)??null,linkedCount:c.service_count,checkedAt:inventory?.checkedAt??null,warnings:inventory?.error?[inventory.error]:inventory?.warnings||['Refresh server inventory to inspect this connection.']}})
}
export async function refreshRemoteStorageInventory(serverId:string,actor:string){
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId)
    const rows=(await client.query("select * from remote_storage_connections where server_id=$1 and provider='postgresql' and provisioning_enabled order by id limit 101",[serverId])).rows
    if(rows.length>100)throw new ApiError('Refresh at most 100 administrator connections at a time',409)
    return enqueueResource(client,serverId,{action:'storage',operation:'inventory',serviceId:serverId,connections:rows.map(c=>({id:c.id,connection:connection(c)}))},actor,serverId)
  })
}
export async function remoteServerDatabases(serverId:string,id:string){
  const connections=await remoteStorageConnections(serverId),c=connections.find(c=>c.id===uuid(id))
  if(!c||c.provider!=='postgresql'||!c.provisioning_enabled)throw new ApiError('PostgreSQL administrator connection not found on this server',404)
  const services=await remoteStorageServices(serverId),discovered=await discoverRemoteStorage(serverId)
  const inventory=c.options.inventory,detached=await detachedRecords({query} as Pick<PoolClient,'query'>,serverId)
  return{server:{id,name:c.name,system:false},checkedAt:inventory?.checkedAt||null,warning:inventory?.error||(!inventory?'Refresh server inventory to list the databases on this connection.':null),databases:(inventory?.databases||[]).map((d:Record<string,any>)=>{
    const linked=services.filter(s=>s.provider==='postgresql'&&physical(s.host)===physical(c.host)&&s.port===c.port&&s.database_name===d.name)
    const configuredFor=discovered.filter(s=>s.engine==='postgresql'&&physical(s.host)===physical(c.host)&&s.port===c.port&&s.database===d.name).map(s=>s.projectName)
    configuredFor.push(...detachedUsage(detached,c,d.name))
    const owned=c.options.createdDatabases?.some((item:Record<string,any>)=>item.name===d.name&&item.oid===d.oid)
    const blocker=['postgres','template0','template1'].includes(d.name)?'This database is protected.':linked.length?'Disconnect the application database links first.':configuredFor.length?'Point every application using this database elsewhere first.':!owned?'This database was not created here. Existing databases are preserved.':null
    return{id:linked[0]?.id||serverDatabaseId(id,d.name),name:d.name,owner:d.owner,sizeBytes:d.sizeBytes,tracked:linked.length>0,apps:linked.map(s=>({name:s.project_name,environment:s.environment})),configuredFor,backup:null,dropBlocker:blocker}
  })}
}
export async function changeRemoteServerDatabase(serverId:string,id:string,name:string|undefined,body:Record<string,unknown>,actor:string){
  await ensureRemoteStorage(serverId)
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId)
    const c=(await client.query("select * from remote_storage_connections where server_id=$1 and id=$2 and provider='postgresql' and provisioning_enabled for update",[serverId,uuid(id)])).rows[0]
    if(!c)throw new ApiError('PostgreSQL administrator connection not found on this server',404)
    if(name){
      if(['postgres','template0','template1'].includes(name))throw new ApiError('This database is protected',409)
      const tracked=(await client.query('select 1 from remote_storage_services s join remote_storage_connections c on c.id=s.connection_id where s.server_id=$1 and c.provider=$2 and c.host=$3 and c.port=$4 and s.database_name=$5',[serverId,c.provider,c.host,c.port,name])).rowCount
      const apps=(await client.query('select env_ciphertext,env_files_ciphertext from remote_apps where server_id=$1',[serverId])).rows
      const configured=apps.some(app=>Object.entries(remoteEnvironmentFiles(app)).some(([file,content])=>parseDatabaseEnv(file,parseEnvironmentText(content)).some(d=>databaseKey(d.engine,d.host,d.port,d.database)===databaseKey(c.provider,c.host,c.port,name))))
      if(tracked||configured||detachedUsage(await detachedRecords(client,serverId),c,name).length)throw new ApiError('An application or preserved detached application still uses this database. Its data is preserved.',409)
      if(body.confirm!==name)throw new ApiError('Type the database name to confirm permanent deletion',400)
      const owned=c.options.createdDatabases?.find((d:Record<string,any>)=>d.name===name)
      if(!owned)throw new ApiError('This database was not created here. Existing databases are preserved.',409)
      return enqueueResource(client,serverId,{action:'storage',operation:'server-drop',serviceId:id,connection:connection(c),database:name,oid:owned.oid},actor,id)
    }
    if(typeof body.name!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]{0,50}$/.test(body.name)||['postgres','template0','template1'].includes(body.name))throw new ApiError('Use a new database name of 1–51 letters, numbers or underscores',400)
    const owner=body.withOwner===false?null:{username:body.name+'_user',password:randomUUID()+randomUUID()}
    return enqueueResource(client,serverId,{action:'storage',operation:'server-create',serviceId:id,connection:connection(c),database:body.name,owner},actor,id)
  })
}
export async function restrictRemoteStorageServer(serverId:string,id:string,actor:string){
  await ensureRemoteStorage(serverId);return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId)
    const c=(await client.query("select * from remote_storage_connections where server_id=$1 and id=$2 and provider='postgresql' and provisioning_enabled and purpose<>'external_service'",[serverId,uuid(id)])).rows[0]
    if(!c||!['127.0.0.1','localhost','::1'].includes(c.host))throw new ApiError('Only a PostgreSQL server on this machine can be restricted here',409)
    return enqueueResource(client,serverId,{action:'storage',operation:'restrict',serviceId:id,connection:connection(c)},actor,id)
  })
}
export async function finishRemoteStorageServerOperation(client:PoolClient,serverId:string,resource:Record<string,any>,success:boolean,result:Record<string,any>|null){
  if(!success)return
  if(resource.operation==='inventory'){
    if(!Array.isArray(result?.connections)||result.connections.length!==resource.connections.length||new Set(result.connections.map((c:Record<string,any>)=>c.id)).size!==resource.connections.length)throw new ApiError('Invalid database inventory receipt',400)
    for(const entry of result.connections){
      if(!resource.connections.some((c:Record<string,any>)=>c.id===entry.id)||entry.ok!==true&&entry.ok!==false)throw new ApiError('Inventory connection does not match this server',400)
      if(entry.ok&&(!Array.isArray(entry.databases)||entry.databases.length>1000||entry.databases.some((d:Record<string,any>)=>typeof d.name!=='string'||Buffer.byteLength(d.name)>63||typeof d.owner!=='string'||!Number.isInteger(d.oid)||!Number.isFinite(d.sizeBytes)||d.sizeBytes<0)))throw new ApiError('Invalid database inventory',400)
      const inventory=entry.ok?{version:entry.version,listen:entry.listen,localOnly:entry.localOnly,ssl:entry.ssl,remoteRules:entry.remoteRules,pendingRestart:entry.pendingRestart,warnings:entry.warnings,databases:entry.databases,checkedAt:new Date().toISOString()}:{error:'The agent could not inspect this connection. Test its saved credentials and permissions.',checkedAt:new Date().toISOString()}
      await client.query("update remote_storage_connections set options=jsonb_set(options,'{inventory}',$3::jsonb),updated_at=now() where server_id=$1 and id=$2",[serverId,entry.id,JSON.stringify(inventory)])
    }
    return
  }
  if(resource.operation==='restrict'){if(result?.restricted!==true)throw new ApiError('Invalid network setting receipt',400);return}
  if(!result||result.database!==resource.database||!Number.isInteger(result.oid))throw new ApiError('Database creation or deletion receipt does not match',400)
  const c=(await client.query('select options from remote_storage_connections where server_id=$1 and id=$2 for update',[serverId,resource.serviceId])).rows[0]
  if(!c)throw new ApiError('Connection was removed during the database operation',409)
  let owned=c.options.createdDatabases||[]
  if(resource.operation==='server-create'){
    if(result.created!==true||resource.owner&&result.owner?.username!==resource.owner.username)throw new ApiError('Invalid database creation receipt',400)
    owned=[...owned,{name:result.database,oid:result.oid}]
  }else{
    if(result.dropped!==true||result.oid!==resource.oid)throw new ApiError('Invalid database deletion receipt',400)
    owned=owned.filter((d:Record<string,any>)=>d.oid!==result.oid)
  }
  await client.query("update remote_storage_connections set options=jsonb_set(options-'inventory','{createdDatabases}',$3::jsonb),updated_at=now() where server_id=$1 and id=$2",[serverId,resource.serviceId,JSON.stringify(owned)])
}
