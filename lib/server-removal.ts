import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { ensureManagedServers, uuid } from '@/lib/managed-servers'
import type { ServerRemovalReview } from '@/lib/server-removal-types'

// Both preview and removal serialize with agent claims, enrollment and app edits.
// Session locks also cover SSH bootstrap and external DNS calls between DB writes.
async function locked<T>(id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  uuid(id)
  await ensureManagedServers()
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("set local lock_timeout = '5s'")
    for (const namespace of ['manager-ssh-setup', 'manager-remote-domains']) {
      const lock = await client.query('select pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) as acquired', [namespace, id])
      if (!lock.rows[0].acquired) throw new ApiError('Server setup or a domain operation is in progress. Wait for it to finish before removing this server.', 409)
    }
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    if ((error as { code?: string }).code === '55P03') throw new ApiError('This server is busy. Refresh the removal review and retry.', 409)
    throw error
  } finally { client.release() }
}

async function snapshot(client: PoolClient, id: string): Promise<ServerRemovalReview> {
  const server = (await client.query('select id,name,platform,enabled,enrolled_at from managed_servers where id=$1 for update', [id])).rows[0]
  if (!server) throw new ApiError('Server not found', 404)
  const apps = (await client.query('select id,name,hostname,environment_name,deployed_at from remote_apps where server_id=$1 order by id', [id])).rows
  const jobs = (await client.query('select id,status from remote_jobs where server_id=$1 order by id', [id])).rows
  const updates = (await client.query('select id,status from remote_agent_updates where server_id=$1 order by id', [id])).rows
  const services = (await client.query('select id,status from remote_service_operations where server_id=$1 order by id', [id])).rows
  const automation = (await client.query('select id,kind,config from remote_automations where server_id=$1 order by id', [id])).rows
  // Domain tables are lazy and need not exist on a new installation.
  const tables = (await client.query("select to_regclass('remote_domains') is not null as domains, to_regclass('remote_domain_operations') is not null as leases")).rows[0]
  const domains = tables.domains ? (await client.query('select id,hostname from remote_domains where server_id=$1 order by id', [id])).rows : []
  const domainBusy = tables.leases && (await client.query('select 1 from remote_domain_operations where server_id=$1 and expires_at>now()', [id])).rowCount
  const blockers: string[] = []
  if (jobs.some(job => job.status === 'running')) blockers.push('A deployment, console command or infrastructure operation is running. Wait for its result. If the agent is unreachable, inspect the server before revoking its access.')
  if (updates.some(update => ['installing', 'recovery_required'].includes(update.status))) blockers.push('An agent update is installing or needs recovery. Resolve it in Agent access & updates first.')
  if (services.some(service => ['running', 'interrupted'].includes(service.status))) blockers.push('A service installation is running or needs recovery. Recover its status in Runtimes & tools before removing its records and credentials.')
  if (domainBusy) blockers.push('A domain operation is in progress. Wait for it to finish; an interrupted operation releases its reservation after three minutes.')
  const review = {
    server: { id: server.id, name: server.name, platform: server.platform, enrolled: !!server.enrolled_at, enabled: server.enabled },
    applications: apps, domains,
    queuedOperations: jobs.filter(job => job.status === 'queued').length + updates.filter(update => update.status === 'queued').length,
    automation: { schedules:automation.filter(a=>a.kind==='cron').length, workers:automation.filter(a=>a.kind==='worker').length },
    history: { jobs: jobs.length, agentUpdates: updates.length, serviceOperations: services.length },
    requiresConfirmation: !!server.enrolled_at || !!apps.length || !!jobs.length || !!updates.length || !!services.length || !!domains.length || !!automation.length,
    blockers,
  }
  // Include record identities and statuses so equal counts cannot hide changed work.
  // Heartbeats and health samples deliberately do not invalidate a review.
  const reviewToken = createHash('sha256').update(JSON.stringify({ review, jobs, updates, services, automation })).digest('hex')
  return { ...review, reviewToken }
}

export function reviewServerRemoval(id: string) {
  return locked(id, client => snapshot(client, id))
}

export function removeServer(id: string, body: Record<string, unknown>, userId: string) {
  return locked(id, async client => {
    const review = await snapshot(client, id)
    if (review.blockers.length) throw new ApiError(review.blockers.join(' '), 409)
    if (body.reviewToken !== review.reviewToken) throw new ApiError('The server changed since you reviewed it. Refresh the removal review and confirm again.', 409)
    if (review.requiresConfirmation && (body.confirmationName !== review.server.name || body.acknowledged !== true)) {
      throw new ApiError('Type the exact server name and acknowledge the permanent loss of management records.', 400)
    }
    // No SSH, process, filesystem, cloud or DNS action belongs in this transaction.
    // Deleting the connection invalidates both enrollment and agent credentials.
    await client.query('update managed_servers set enabled=false,agent_hash=null,enrollment_hash=null where id=$1', [id])
    const tables = (await client.query("select to_regclass('remote_domains') is not null as domains, to_regclass('remote_domain_operations') is not null as leases")).rows[0]
    if (tables.domains) await client.query('delete from remote_domains where server_id=$1', [id])
    if (tables.leases) await client.query('delete from remote_domain_operations where server_id=$1', [id])
    const ai=(await client.query("select to_regclass('remote_ai_settings') is not null as settings, to_regclass('manager_ai_events') is not null as events")).rows[0]
    if(ai.settings)await client.query('delete from remote_ai_settings where server_id=$1',[id])
    if(ai.events)await client.query('delete from manager_ai_events where server_id=$1',[id])
    await client.query('delete from remote_jobs where server_id=$1', [id])
    await client.query('delete from remote_agent_updates where server_id=$1', [id])
    await client.query('delete from remote_service_operations where server_id=$1', [id])
    // Break staging references within this server before deleting production apps.
    await client.query('update remote_apps set production_id=null where server_id=$1', [id])
    await client.query('delete from remote_apps where server_id=$1', [id])
    await client.query('delete from managed_servers where id=$1', [id])
    // Keep the removal audit in the same transaction; a failed audit rolls back deletion.
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)', [userId, 'server.remove', id, JSON.stringify({ serverName: review.server.name, enrolled: review.server.enrolled, applications: review.applications.map(app => ({ id: app.id, name: app.name })), domains: review.domains.map(domain => domain.hostname), queuedOperations: review.queuedOperations, history: review.history, preservedRemoteResources: true })])
    return { ok: true }
  })
}
