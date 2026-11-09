import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ApiError } from './api'
import { query } from './db'
import { decryptSecret } from './secret-crypto'
import { serverDetail, uuid } from './managed-servers'
import { queueResource } from './remote-resources'
import { idleConnectionNotes, mysqlRecommendations, tuningSettings } from './database-tuning-policy'

async function connections(serverId:string) {
  const {apps,server}=await serverDetail(serverId),out:Record<string,any>[]=[]
  const services=(await query("select id,credentials_ciphertext from remote_service_operations where server_id=$1 and status='success' and credentials_ciphertext is not null order by created_at desc",[serverId])).rows
  for(const service of services){const d=JSON.parse(decryptSecret(service.credentials_ciphertext));if(!['postgresql','mysql','mariadb'].includes(d.provider)||out.some(r=>r.provider===d.provider&&r.port===d.port))continue;out.push({...d,id:service.id,database:d.provider==='postgresql'?'postgres':'mysql',name:d.provider,apps:apps.filter(a=>a.database_config?.provider===d.provider&&a.database_config?.port===d.port).map(a=>a.name)})}
  for(const row of (await query('select id,name,database_ciphertext from remote_apps where server_id=$1 and database_ciphertext is not null',[serverId])).rows){const d=JSON.parse(decryptSecret(row.database_ciphertext));if(!['127.0.0.1','localhost','::1'].includes(d.host)||out.some(r=>r.provider===d.provider&&r.port===d.port))continue;out.push({...d,id:row.id,name:d.provider,apps:[row.name]})}
  return {connections:out,platform:server.platform,root:server.metrics?.resources?.root||'',tools:server.metrics?.tools||{}}
}
export function decorateDatabaseResult(result:Record<string,any>,canTune:boolean) {
  if(!Array.isArray(result?.servers))return result
  return {...result,canTune,servers:result.servers.map((s:Record<string,any>)=>({...s,recommendations:s.facts&&s.service&&s.platform==='win32'?mysqlRecommendations(s.facts):[],notes:[...(s.notes||[]),...idleConnectionNotes(s.connections?.groups||[])]}))}
}
export async function remoteDatabases(serverId:string,role:string,actor?:string) {
  const {connections:items,tools}=await connections(serverId)
  if(actor)return queueResource(serverId,{action:'database-inspect',connections:items,tools},actor)
  const last=(await query("select result from remote_jobs where server_id=$1 and resource_action='database-inspect' and status='success' order by created_at desc limit 1",[serverId])).rows[0]
  return decorateDatabaseResult(last?.result||{servers:[]},role==='admin')
}
export async function tuneRemoteDatabase(serverId:string,body:Record<string,unknown>,actor:string) {
  const {connections:items,platform}=await connections(serverId),connection=items.find(c=>c.id===uuid(body.connectionId))
  if(!connection||platform!=='win32'||!['mysql','mariadb'].includes(connection.provider))throw new ApiError('A connected Windows MySQL or MariaDB service is required for these tuning controls',409)
  const row=(await query("select result,finished_at from remote_jobs where server_id=$1 and resource_action='database-inspect' and status='success' order by created_at desc limit 1",[serverId])).rows[0]
  const report=decorateDatabaseResult(row?.result||{},true).servers?.find((s:Record<string,any>)=>s.connectionId===connection.id)
  if(!report?.service||!report.facts||Date.now()-Date.parse(row.finished_at)>300000)throw new ApiError('Check database servers again before reviewing tuning changes',409)
  let settings:string;try{settings=tuningSettings(report.recommendations,body.keys)}catch(error){throw new ApiError((error as Error).message,400)}
  const tune=await readFile(path.join(process.cwd(),'scripts/tune-database-memory.ps1'),'utf8'),service=await readFile(path.join(process.cwd(),'scripts/database-service.ps1'),'utf8')
  return queueResource(serverId,{action:'database-tune',connection,settings,service:report.service,port:connection.port,facts:report.facts,script:tune,serviceScript:service},actor)
}
