import { ApiError } from './api'
import { audit } from './audit'
import { db, query } from './db'
import { ensureManagedServers, uuid } from './managed-servers'
import { decryptSecret, encryptSecret } from './secret-crypto'
import { validateConsoleCommand } from './project-console'
import { databaseEnvironment, CONSOLE_CAPABILITY } from '@/scripts/manager-agent.cjs'

export async function remoteConsoleHistory(serverId: string, appId: string | null) {
  await ensureManagedServers(); uuid(serverId); if (appId) uuid(appId)
  return { jobs: (await query(`select id,kind,status,log,created_at,finished_at,cancel_requested,result from remote_jobs
    where server_id=$1 and app_id is not distinct from $2::uuid and operation_type is null and kind in ('console','logs') order by created_at desc limit 10`, [serverId, appId])).rows }
}

export async function queueRemoteConsole(serverId: string, appId: string | null, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId); if (appId) uuid(appId)
  const kind = body.action === 'logs' ? 'logs' : body.action === 'run' ? 'console' : null
  if (!kind || kind === 'logs' && !appId) throw new ApiError('Choose a console command or application logs',400)
  if (kind === 'console') { const error=validateConsoleCommand(body.command); if(error)throw new ApiError(error,400) }
  const cwd=typeof body.cwd==='string'?body.cwd:'.'
  if(cwd.length>1024 || /[\x00-\x1f]/.test(cwd))throw new ApiError('Invalid working directory',400)
  const client=await db.connect()
  let id:string
  try {
    await client.query('begin')
    const server=(await client.query('select * from managed_servers where id=$1 for update',[serverId])).rows[0]
    if(!server?.enabled || !server.enrolled_at || !server.last_seen_at || Date.now()-Date.parse(server.last_seen_at)>90_000)throw new ApiError('Connect this server before opening its console',409)
    if(!server.metrics?.capabilities?.includes(CONSOLE_CAPABILITY))throw new ApiError('Update the agent to enable remote console and runtime logs',409)
    if((await client.query("select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted')",[serverId])).rowCount)throw new ApiError('Finish the service operation before opening the console',409)
    if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running')",[serverId])).rowCount)throw new ApiError('Wait for the current server operation to finish',409)
    if((await client.query("select 1 from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')",[serverId])).rowCount)throw new ApiError('Finish the agent update or recovery before opening the console',409)
    if(!(await client.query("select pg_try_advisory_xact_lock(hashtext('manager-ssh-setup'),hashtext($1)) as ok",[serverId])).rows[0]?.ok)throw new ApiError('Server setup is running',409)
    let environment={}
    if(appId){
      const app=(await client.query('select * from remote_apps where id=$1 and server_id=$2',[appId,serverId])).rows[0]
      if(!app?.live_commit)throw new ApiError('Deploy this application before opening its runtime tools',409)
      const database=app.database_config?.status==='ready'&&app.database_ciphertext?JSON.parse(decryptSecret(app.database_ciphertext)):null
      environment={...JSON.parse(decryptSecret(app.env_ciphertext)),...(database?databaseEnvironment(database):{})}
    }
    const payload={id:appId,command:kind==='console'?String(body.command).trim():'',cwd,environment,expiresAt:Date.now()+60_000,requiredCapability:CONSOLE_CAPABILITY}
    id=(await client.query('insert into remote_jobs(server_id,app_id,user_id,kind,payload_ciphertext) values($1,$2,$3,$4,$5) returning id',[serverId,appId,userId,kind,encryptSecret(JSON.stringify(payload))])).rows[0].id
    await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
  // Do not put commands, which can contain passwords, into audit metadata.
  await audit(userId,'remote.'+kind,appId||serverId,{serverId,jobId:id})
  return {id}
}

export async function cancelRemoteConsole(serverId: string, id: unknown, userId: string, appId: string | null = null) {
  await ensureManagedServers();uuid(serverId);uuid(id)
  const result=await query(`update remote_jobs set cancel_requested=true,
    status=case when status='queued' then 'cancelled' else status end,
    payload_ciphertext=case when status='queued' then null else payload_ciphertext end,
    finished_at=case when status='queued' then now() else finished_at end
    where server_id=$1 and id=$2 and app_id is not distinct from $3::uuid and operation_type is null and kind in ('console','logs') and status in ('queued','running') returning id`,[serverId,id,appId?uuid(appId):null])
  if(!result.rowCount)throw new ApiError('This console operation has already finished',409)
  await audit(userId,'remote.console.cancel',String(id),{serverId});return {ok:true}
}
