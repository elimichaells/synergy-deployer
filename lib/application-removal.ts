import { createHash } from 'node:crypto'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { ApiError } from '@/lib/api'
import { db, query } from '@/lib/db'
import { ensureManagedServers, uuid } from '@/lib/managed-servers'
import { encryptSecret } from '@/lib/secret-crypto'
import type { ApplicationRemovalReview } from './application-removal-types'

export const APPLICATION_CONTROL_CAPABILITY = 'application-control-v1'
let schema: Promise<unknown> | undefined
function ensureArchive() {
  return schema ??= query(`create table if not exists removed_application_records (
    id uuid primary key default gen_random_uuid(), application_id uuid not null, server_id uuid,
    name text not null, record_ciphertext text not null, removed_by uuid references users(id) on delete set null,
    removed_at timestamptz not null default now()
  )`).catch(error => { schema = undefined; throw error })
}
async function exists(client: PoolClient, table: string) {
  return !!(await client.query('select to_regclass($1) as name', [table])).rows[0].name
}
async function rows(client: PoolClient, table: string, column: string, id: string) {
  return await exists(client, table) ? (await client.query(`select * from ${table} where ${column}=$1 order by ${table === 'project_databases' ? 'project_id' : 'id'} for update`, [id])).rows : []
}
async function locked<T>(serverId: string | null, appId: string, work: (client: PoolClient) => Promise<T>) {
  uuid(appId); if (serverId) { uuid(serverId); await ensureManagedServers() }
  await ensureArchive()
  const client = await db.connect()
  try {
    await client.query('begin'); await client.query("set local lock_timeout='5s'")
    for (const namespace of serverId ? ['manager-ssh-setup','manager-remote-domains'] : ['manager-project']) {
      if (!(await client.query('select pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) as ok', [namespace, serverId || appId])).rows[0].ok) throw new ApiError('Another operation is using this application or server. Wait for it to finish.', 409)
    }
    if (serverId && !(await client.query('select id from managed_servers where id=$1 for update', [serverId])).rowCount) throw new ApiError('Server not found', 404)
    const result = await work(client); await client.query('commit'); return result
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
async function snapshot(client: PoolClient, serverId: string | null, appId: string) {
  const app = (await client.query(serverId ? 'select * from remote_apps where id=$1 and server_id=$2 for update' : 'select * from projects where id=$1 for update', serverId ? [appId,serverId] : [appId])).rows[0]
  if (!app) throw new ApiError('Application not found on this server', 404)
  const table = serverId ? 'remote_apps' : 'projects'
  const related = (await client.query(`select id,name from ${table} where production_id=$1 order by id for update`, [appId])).rows
  const jobs = await rows(client, serverId ? 'remote_jobs' : 'deployments', serverId ? 'app_id' : 'project_id', appId)
  const domains = await rows(client, serverId ? 'remote_domains' : 'project_domains', 'project_id', appId)
  const connections = await rows(client, serverId ? 'remote_storage_services' : 'project_data_services', serverId ? 'app_id' : 'project_id', appId)
  if(serverId&&connections.length){const servers=(await client.query('select id,provider,host,port from remote_storage_connections where server_id=$1',[serverId])).rows;for(const item of connections){const connection=servers.find(c=>c.id===item.connection_id);if(connection)Object.assign(item,{provider:connection.provider,host:connection.host,port:connection.port})}}
  const migrations = serverId ? (await client.query("select * from remote_storage_changes where server_id=$1 and app_id=$2 and kind='migration' order by id for update",[serverId,appId])).rows : await rows(client, 'data_migration_jobs', 'project_id', appId)
  const schedules = serverId ? (await client.query("select * from remote_automations where server_id=$1 and config->>'projectId'=$2 order by id for update", [serverId,appId])).rows : await rows(client, 'cron_jobs', 'project_id', appId)
  const databases = serverId ? [] : await rows(client, 'project_databases', 'project_id', appId)
  const backups = !serverId && databases.length && await exists(client,'backup_schedules') ? (await client.query('select * from backup_schedules where database_name=any($1::text[]) order by id for update',[databases.map(d=>d.database_name)])).rows : []
  const backupTable=serverId?'remote_storage_schedules':'data_service_backup_schedules'
  const serviceBackups = await exists(client,backupTable) ? (await client.query(`select * from ${backupTable} where service_id=any($1::uuid[]) order by id for update`,[connections.map(c=>c.id)])).rows : []
  const blockers: string[] = []
  if (jobs.some(j => j.status === 'running')) blockers.push('An application operation is running. Wait for completion or cancel it first.')
  if (migrations.some(j => ['queued','running','validating','needs_review'].includes(j.status))) blockers.push('Finish or verify the active database migration first.')
  if ([...schedules,...backups,...serviceBackups].some(j => j.last_status === 'running')) blockers.push('An application schedule or backup is running.')
  if (!serverId && (app.sleep_after_minutes || app.sleeping_since)) blockers.push('Disable staging sleep and wake this application before removing it, so its site remains available.')
  if (!serverId && connections.length && await exists(client,'data_migration_jobs') && (await client.query('select 1 from data_migration_jobs where project_id<>$1 and (source_service_id=any($2::uuid[]) or target_service_id=any($2::uuid[])) limit 1',[appId,connections.map(c=>c.id)])).rowCount) blockers.push('Another application has migration history referencing this database. Resolve that dependency first.')
  if (!serverId && (app.pm2_name === 'manager' || path.resolve(app.root_path).toLowerCase() === path.resolve(process.env.MANAGER_ROOT || process.cwd()).toLowerCase())) blockers.push('Manager cannot remove its own application.')
  if (!serverId && await exists(client, 'project_domain_routes')) {
    if ((await client.query('select 1 from project_domain_routes r join project_domains d on d.id=r.domain_id where r.project_id=$1 or d.project_id=$1 limit 1', [appId])).rowCount) blockers.push('Remove shared domain paths before removing this application.')
  }
  if (connections.length && (await client.query(`select 1 from ${serverId?'remote_storage_services':'project_data_services'} where ${serverId?'app_id':'project_id'}<>$1 and options->>'sharedFrom'=any($2::text[]) limit 1`, [appId,connections.map(c => c.id)])).rowCount) blockers.push('Another application shares this application’s database. Unlink the shared connection first.')
  if (schedules.length) blockers.push('Remove or reassign this application’s scheduled jobs and workers first.')
  if(!serverId&&await exists(client,'workers')){
    const root=path.resolve(app.root_path).toLowerCase()
    const workers=(await client.query('select working_directory from workers')).rows
    if(workers.some(worker=>{const directory=path.resolve(worker.working_directory).toLowerCase();return directory===root||directory.startsWith(root+path.sep)}))blockers.push('Remove or reassign background workers using this application directory first.')
  }
  let requiresAgent = false
  if (serverId) {
    await client.query("delete from remote_storage_changes where server_id=$1 and app_id=$2 and kind='migration'",[serverId,appId])
    if(await exists(client,'remote_storage_changes')&&(await client.query("select 1 from remote_storage_changes where server_id=$1 and status in ('running','needs_review')",[serverId])).rowCount)blockers.push('Verify the pending database change in Storage before removing applications.')
    if(await exists(client,'remote_storage_renames')&&(await client.query("select 1 from remote_storage_renames where server_id=$1 and status in ('running','needs_review') and apps @> $2::jsonb",[serverId,JSON.stringify([{projectId:appId}])])).rowCount)blockers.push('Verify the pending database rename before removing this application.')
    if(await exists(client,'remote_domain_routes')&&(await client.query('select 1 from remote_domain_routes r join remote_domains d on d.id=r.domain_id where r.server_id=$1 and (r.project_id=$2 or d.project_id=$2) limit 1',[serverId,appId])).rowCount)blockers.push('Remove shared domain paths before removing this application.')
    const server = (await client.query('select * from managed_servers where id=$1', [serverId])).rows[0]
    const resource = server.metrics?.resources?.apps?.find((a:{id:string})=>a.id===appId)
    if (resource?.sleepAfterMinutes || resource?.sleepingSince) blockers.push('Disable staging sleep and wake this application before removing it, so its site remains available.')
    requiresAgent = !!app.live_commit || !!app.deployed_at || jobs.some(j => j.kind === 'deploy' && j.status !== 'queued' && j.status !== 'cancelled') || !!server.metrics?.apps?.some((a: {id:string}) => a.id === appId)
    if ((await client.query("select 1 from remote_jobs where server_id=$1 and app_id is distinct from $2::uuid and status in ('queued','running') union all select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted') union all select 1 from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')", [serverId,appId])).rowCount) blockers.push('Finish the current server operation or recovery first.')
    if (await exists(client, 'remote_domain_operations') && (await client.query('select 1 from remote_domain_operations where server_id=$1 and expires_at>now()', [serverId])).rowCount) blockers.push('A domain change is in progress.')
    if (requiresAgent && (!server.enabled || !server.last_seen_at || Date.now()-Date.parse(server.last_seen_at)>90000)) blockers.push('Reconnect this server so its agent can preserve the running application and detach its management safely.')
    if (requiresAgent && !server.metrics?.capabilities?.includes(APPLICATION_CONTROL_CAPABILITY)) blockers.push('Update the agent in Agent access & updates before removing a deployed application.')
  }
  const application = { id: appId, name: app.name, environment: app.environment_name || app.environment || 'production', serverId }
  const review = { application, domains: [...new Set([app.hostname || app.url,...domains.map(d => d.hostname)].filter((x): x is string => !!x && !x.endsWith('.invalid')))], related, queuedJobs: jobs.filter(j => j.status === 'queued').length, requiresAgent, blockers }
  const record = { app, domains, connections, databases, migrations, schedules, backups, serviceBackups }
  const reviewToken = createHash('sha256').update(JSON.stringify({record, related, jobs:jobs.map(j => [j.id,j.status])})).digest('hex')
  return { review: {...review,reviewToken} as ApplicationRemovalReview, record }
}
export function reviewApplicationRemoval(serverId: string | null, appId: string) {
  return locked(serverId, appId, async client => (await snapshot(client,serverId,appId)).review)
}
async function erase(client: PoolClient, serverId: string | null, appId: string, actor: string, record: Record<string,any>, keepJob?: string) {
  await client.query('insert into removed_application_records(application_id,server_id,name,record_ciphertext,removed_by) values($1,$2,$3,$4,$5)', [appId,serverId,record.app.name,encryptSecret(JSON.stringify(record)),actor])
  if (serverId) {
    if (await exists(client,'remote_domains')) await client.query('delete from remote_domains where server_id=$1 and project_id=$2', [serverId,appId])
    if (keepJob) await client.query('update remote_jobs set app_id=null where id=$1 and server_id=$2', [keepJob,serverId])
    await client.query('delete from remote_jobs where server_id=$1 and app_id=$2', [serverId,appId])
    await client.query('update remote_apps set production_id=null where server_id=$1 and production_id=$2', [serverId,appId])
    await client.query('delete from remote_apps where server_id=$1 and id=$2', [serverId,appId])
  } else {
    // Remove finished migration references before the owning service records cascade.
    if (await exists(client,'data_migration_jobs')) await client.query('delete from data_migration_jobs where project_id=$1', [appId])
    await client.query('delete from projects where id=$1', [appId])
  }
  await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)', [actor,'application.remove',appId,JSON.stringify({serverId,name:record.app.name,retainedFiles:true,retainedProcesses:true,retainedDatabases:true,retainedRoutes:true})])
}
export function removeApplication(serverId: string | null, appId: string, body: Record<string,unknown>, actor: string) {
  return locked(serverId, appId, async client => {
    const {review,record} = await snapshot(client,serverId,appId)
    if (review.blockers.length) throw new ApiError(review.blockers.join(' '),409)
    if (body.reviewToken !== review.reviewToken) throw new ApiError('The application changed. Refresh the removal review and confirm again.',409)
    if (body.confirmationName !== review.application.name || body.acknowledged !== true) throw new ApiError('Type the exact application name and acknowledge the loss of management.',400)
    if (serverId && review.requiresAgent) {
      await client.query("update remote_jobs set status='cancelled',payload_ciphertext=null,finished_at=now() where server_id=$1 and app_id=$2 and status='queued'",[serverId,appId])
      const payload = {action:'detach',id:appId,requiredCapability:APPLICATION_CONTROL_CAPABILITY,expiresAt:Date.now()+60000}
      const job=(await client.query("insert into remote_jobs(server_id,app_id,user_id,kind,operation_type,resource_action,payload_ciphertext) values($1,$2,$3,'console','infrastructure','app-remove',$4) returning id",[serverId,appId,actor,encryptSecret(JSON.stringify(payload))])).rows[0]
      await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'application.remove.request',appId,JSON.stringify({serverId,jobId:job.id})])
      return {jobId:job.id}
    }
    await erase(client,serverId,appId,actor,record); return {ok:true}
  })
}
/** Called only for an authenticated, successful acknowledgement of the queued removal. */
export async function finishApplicationRemoval(client: PoolClient, serverId: string, job: Record<string,any>, payload: Record<string,any>, result: Record<string,any>) {
  if (job.resource_action !== 'app-remove' || payload.action !== 'detach' || payload.id !== job.app_id || result.detachedAppId !== job.app_id || result.preservedResources !== true) throw new ApiError('Invalid application removal acknowledgement',400)
  const {record} = await snapshot(client,serverId,job.app_id)
  await erase(client,serverId,job.app_id,job.user_id,record,job.id)
}
