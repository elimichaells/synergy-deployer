import { ApiError } from '@/lib/api'
import { db,query } from '@/lib/db'
import { ensureManagedServers,uuid } from '@/lib/managed-servers'
import { decryptSecret,encryptSecret } from '@/lib/secret-crypto'
import { environmentText,parseEnvironmentText } from '@/lib/environment-text'
import { validateApp } from '@/scripts/manager-agent.cjs'

export function remoteEnvironmentFiles(app:{env_files_ciphertext?:string;env_ciphertext:string}):Record<string,string>{
  return app.env_files_ciphertext?JSON.parse(decryptSecret(app.env_files_ciphertext)):{'.env':environmentText(JSON.parse(decryptSecret(app.env_ciphertext))),'.env.local':''}
}
function filename(value:unknown){if(!['.env','.env.local'].includes(String(value)))throw new ApiError('Unsupported env file',400);return String(value)}
export async function readRemoteEnvironmentFile(serverId:string,appId:string,file:unknown){
  await ensureManagedServers();const name=filename(file)
  const app=(await query<{env_files_ciphertext:string;env_ciphertext:string}>('select env_ciphertext,env_files_ciphertext from remote_apps where server_id=$1 and id=$2',[uuid(serverId),uuid(appId)])).rows[0]
  if(!app)throw new ApiError('Application not found on this server',404)
  return{file:name,content:remoteEnvironmentFiles(app)[name]||''}
}
export async function saveRemoteEnvironmentFile(serverId:string,appId:string,body:Record<string,unknown>,actor:string){
  await ensureManagedServers();uuid(serverId);uuid(appId);const file=filename(body.file)
  if(typeof body.content!=='string'||body.content.length>100000)throw new ApiError('Environment content must be text, at most 100,000 characters',400)
  const client=await db.connect()
  try{
    await client.query('begin');await client.query('select id from managed_servers where id=$1 for update',[serverId])
    const app=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,appId])).rows[0]
    if(!app)throw new ApiError('Application not found on this server',404)
    if((await client.query("select 1 from remote_storage_changes where server_id=$1 and status in ('running','needs_review')",[serverId])).rowCount)throw new ApiError('Verify the pending database change in Storage before editing environment files',409)
    if((await client.query("select 1 from remote_jobs where server_id=$1 and (app_id=$2 or resource_action='storage') and status in ('queued','running')",[serverId,appId])).rowCount)throw new ApiError('Wait for this application or storage operation to finish before editing its environment',409)
    const files=remoteEnvironmentFiles(app)
    if(typeof body.previousContent!=='string'||body.previousContent!==(files[file]||''))throw new ApiError('This file changed elsewhere. Reload it before saving.',409)
    files[file]=body.content
    let environment;try{environment={...parseEnvironmentText(files['.env']||''),...(app.project_type==='laravel'?{}:parseEnvironmentText(files['.env.local']||''))};validateApp({...app,start_cmd:app.start_cmd||'npm start',environment})}catch(error){throw new ApiError((error as Error).message,400)}
    await client.query("update remote_apps set env_files_ciphertext=$3,env_ciphertext=$4,env_names=$5,setup_decisions=setup_decisions||jsonb_build_object('environment','reviewed') where server_id=$1 and id=$2",[serverId,appId,encryptSecret(JSON.stringify(files)),encryptSecret(JSON.stringify(environment)),Object.keys(environment).sort()])
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.environment.save',appId,JSON.stringify({serverId,file})])
    await client.query('commit');return{ok:true}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
}
