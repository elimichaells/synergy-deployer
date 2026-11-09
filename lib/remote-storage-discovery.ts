import {randomUUID} from 'node:crypto'
import {ApiError} from './api'
import {query} from './db'
import {encryptSecret} from './secret-crypto'
import {uuid} from './managed-servers'
import {remoteEnvironmentFiles} from './remote-environment'
import {parseEnvironmentText} from './environment-text'
import {parseDatabaseEnv,uniqueDatabases,databaseKey} from './database-discovery-policy'
import {ensureRemoteStorage,remoteStorageConnections,remoteStorageServices} from './remote-storage'
import {admitResource,enqueueResource,resourceTransaction} from './remote-resources'

async function candidates(serverId:string,appId?:string){
  await ensureRemoteStorage(serverId)
  const apps=(await query('select * from remote_apps where server_id=$1 and ($2::uuid is null or id=$2)',[uuid(serverId),appId?uuid(appId):null])).rows
  if(appId&&!apps.length)throw new ApiError('Application not found on this server',404)
  return apps.filter(app=>app.project_type!=='angular').flatMap(app=>{
    const files=remoteEnvironmentFiles({env_ciphertext:app.env_ciphertext,env_files_ciphertext:app.env_files_ciphertext}),order=app.project_type==='laravel'?['.env']:['.env.local','.env']
    return uniqueDatabases(order.flatMap(file=>parseDatabaseEnv(file,parseEnvironmentText(files[file]||'')))).map(item=>({...item,projectId:app.id,projectName:app.name,environment:app.environment_name,groupId:app.application_group_id}))
  })
}
export async function discoverRemoteStorage(serverId:string,appId?:string){
  const found=await candidates(serverId,appId),connections=await remoteStorageConnections(serverId),services=await remoteStorageServices(serverId)
  return found.filter(item=>!services.some(s=>s.project_id===item.projectId&&databaseKey(s.provider,s.host,s.port,s.database_name)===databaseKey(item.engine,item.host,item.port,item.database))).map(({password:_password,...item})=>{
    const connection=connections.find(c=>databaseKey(c.provider,c.host,c.port,'')===databaseKey(item.engine,item.host,item.port,''))
    const peers=services.filter(s=>s.project_id!==item.projectId&&databaseKey(s.provider,s.host,s.port,s.database_name)===databaseKey(item.engine,item.host,item.port,item.database)),saved=found.filter(s=>s.projectId!==item.projectId&&databaseKey(s.engine,s.host,s.port,s.database)===databaseKey(item.engine,item.host,item.port,item.database))
    return{...item,connectionName:connection?.name||null,systemServer:false,external:!connection,superuser:['postgres','root','sa'].includes(item.username||''),usedBy:[...new Set([...peers.map(s=>s.project_name),...saved.map(s=>s.projectName)])],sharedWithProduction:item.environment!=='production'&&(peers.some(s=>s.environment==='production')||saved.some(s=>s.environment==='production'))}
  })
}
export async function adoptRemoteStorage(serverId:string,appId:string,source:unknown,actor:string){
  const before=(await candidates(serverId,appId)).find(item=>item.source===source);if(!before)throw new ApiError('The saved database setting changed. Refresh Storage.',409)
  return resourceTransaction(serverId,async client=>{
    await admitResource(client,serverId)
    const app=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,uuid(appId)])).rows[0];if(!app)throw new ApiError('Application not found',404)
    const files=remoteEnvironmentFiles(app),file=before.source.split(':')[0],current=parseDatabaseEnv(file,parseEnvironmentText(files[file]||'')).find(item=>item.source===before.source)
    if(!current||JSON.stringify(current)!==JSON.stringify(Object.fromEntries(Object.entries(before).filter(([key])=>!['projectId','projectName','environment','groupId'].includes(key)))))throw new ApiError('The saved database setting changed. Refresh Storage.',409)
    if(!current.username&&current.engine!=='redis')throw new ApiError('Save a database username in this application’s environment first',409)
    const connections=(await client.query('select * from remote_storage_connections where server_id=$1',[serverId])).rows
    let connection=connections.find(c=>databaseKey(c.provider,c.host,c.port,'')===databaseKey(current.engine,current.host,current.port,''))
    if(!connection){connection={id:randomUUID()};await client.query(`insert into remote_storage_connections(id,server_id,name,provider,host,port,username,password_ciphertext,tls_enabled,options,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[connection.id,serverId,`${app.name} · ${connection.id.slice(0,8)}`,current.engine,current.host.replace(/^\[|\]$/g,''),current.port,current.username||'',encryptSecret(current.password||''),current.tls,JSON.stringify({database:current.database}),actor])}
    const id=randomUUID(),name='linked_'+id.slice(0,8)
    if((await client.query('select 1 from remote_storage_services where server_id=$1 and app_id=$2 and connection_id=$3 and database_name=$4',[serverId,appId,connection.id,current.database])).rowCount)throw new ApiError('This database is already linked to this application',409)
    await client.query(`insert into remote_storage_services(id,server_id,app_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,options,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,serverId,appId,connection.id,name,current.database,current.username||'',encryptSecret(current.password||''),name.toUpperCase(),JSON.stringify({ownership:'adopted',injectEnv:false,source:current.source}),actor])
    const job=await enqueueResource(client,serverId,{action:'storage',operation:'test',serviceId:id,connection:{provider:current.engine,host:current.host.replace(/^\[|\]$/g,''),port:current.port,username:current.username||'',password:current.password||'',database:current.database,tls:current.tls}},actor,id)
    return{...job,database:current.database}
  })
}
