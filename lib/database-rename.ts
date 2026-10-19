import { Client } from 'pg'
import { readFile } from 'fs/promises'
import path from 'path'
import { parse } from 'dotenv'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { ensureDataServicesSchema, getSecretConnection, connectionPassword } from '@/lib/data-services'
import { quoteIdent } from '@/lib/db-admin'
import { hostKey } from '@/lib/database-discovery-policy'
import { parseServerDatabaseId, isProtectedDatabase } from '@/lib/server-database-policy'
import { renameEnvSettings, renameNameError } from '@/lib/database-rename-policy'

const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']
export interface RenameApp { projectId: string; name: string; environment: string; settings: string[] }
export interface RenamePlan { database: string; server: string; apps: RenameApp[]; sessions: { application: string; count: number }[]; blockers: string[] }
type ManagerQueries = { query: typeof query }

export async function ensureDatabaseRenameSchema() {
  await ensureDataServicesSchema()
  await query(`create table if not exists database_renames (
    id uuid primary key default gen_random_uuid(), connection_id uuid not null,
    old_name text not null, new_name text not null, apps jsonb not null,
    status text not null default 'running', error text, created_by uuid,
    created_at timestamptz not null default now(), finished_at timestamptz)`)
}

export async function listDatabaseRenames() {
  await ensureDatabaseRenameSchema()
  return (await query<{ id: string; old_name: string; new_name: string; apps: RenameApp[]; status: string; error: string | null }>(
    `select id,old_name,new_name,apps,status,error from database_renames where status in ('running','needs_review','succeeded') order by created_at desc limit 100`)).rows
}

async function target(id: string) {
  const raw = parseServerDatabaseId(id)
  const service = raw ? null : (await query<{ connection_id: string; database_name: string }>('select connection_id,database_name from project_data_services where id=$1', [id])).rows[0]
  if (!raw && !service) throw new ApiError('Database not found', 404)
  const connection = await getSecretConnection(raw?.connectionId || service!.connection_id)
  if (connection.provider !== 'postgresql' || !connection.username) throw new ApiError('Renaming requires a PostgreSQL server with a saved administrator connection.', 409)
  const database = raw?.database || service!.database_name
  let control = process.env.DATABASE_NAME || 'server_manager'
  let controlHost = process.env.DATABASE_HOST || '127.0.0.1'
  let controlPort = Number(process.env.DATABASE_PORT || 5432)
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    control = decodeURIComponent(url.pathname.slice(1)); controlHost = url.hostname; controlPort = Number(url.port || 5432)
  }
  const system = connection.options?.system === true || (hostKey(controlHost) === hostKey(connection.host) && controlPort === connection.port)
  if (isProtectedDatabase(database, control, system)) throw new ApiError('This database is protected. Manager needs it.', 409)
  const client = new Client({ host: connection.host, port: connection.port, user: connection.username, password: connectionPassword(connection),
    database: database === 'postgres' ? 'template1' : 'postgres', ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000, statement_timeout: 15000, application_name: 'manager-database-rename' })
  return { connection, database, client, control, system }
}

async function inventory(t: Awaited<ReturnType<typeof target>>, manager: ManagerQueries) {
  const services = (await manager.query<{ id: string; project_id: string; host: string; port: number; env_prefix: string }>(
    `select s.id,s.project_id,c.host,c.port,s.env_prefix from project_data_services s join data_connections c on c.id=s.connection_id
     where c.provider='postgresql' and s.database_name=$1`, [t.database])).rows
    .filter(row => hostKey(row.host) === hostKey(t.connection.host) && row.port === t.connection.port)
  const apps: RenameApp[] = [], blockers: string[] = []
  const projects = (await manager.query<{ id: string; name: string; environment: string; root_path: string }>('select id,name,environment,root_path from projects order by name')).rows
  for (const project of projects) {
    const settings: string[] = []
    for (const file of ENV_FILES) {
      try { settings.push(...renameEnvSettings(file, parse(await readFile(path.join(project.root_path, file))), { host: t.connection.host, port: t.connection.port, database: t.database })) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') blockers.push(`Cannot inspect ${project.name}'s ${file}. Fix file access before renaming.`) }
    }
    const linked = services.filter(service => service.project_id === project.id)
    if (settings.length || linked.length) apps.push({ projectId: project.id, name: project.name, environment: project.environment,
      settings: [...new Set([...settings, ...linked.map(service => `Manager Storage: ${service.env_prefix}`)])] })
  }
  return { services, apps, blockers }
}

async function review(t: Awaited<ReturnType<typeof target>>, manager: ManagerQueries) {
  const usage = await inventory(t, manager)
  const exists = await t.client.query('select 1 from pg_database where datname=$1', [t.database])
  if (!exists.rows.length) throw new ApiError('The database no longer exists on this server. Refresh Storage.', 409)
  const sessions = (await t.client.query<{ application: string; count: number }>(
    `select coalesce(nullif(application_name,''),'Unnamed database client') as application,count(*)::int as count
     from pg_stat_activity where datname=$1 group by application_name`, [t.database])).rows
  const blockers = [...usage.blockers]
  if (sessions.length) blockers.push('Stop every app and worker using this database, and close database clients before renaming. No connections will be terminated automatically.')
  const pending = await manager.query(`select id from database_renames where status in ('running','needs_review') limit 1`)
  if (pending.rows.length) blockers.push('An earlier rename is running or needs review. Check rename history before continuing.')
  const ids = usage.apps.map(app => app.projectId)
  if ((await manager.query(`select id from deployments where project_id=any($1::uuid[]) and status in ('queued','running') limit 1`, [ids])).rows.length) blockers.push('Wait for the affected applications to finish deploying.')
  for (const table of ['database_moves', 'data_migration_jobs', 'data_service_backup_schedules', 'backup_schedules', 'cron_jobs']) {
    if (!(await manager.query('select to_regclass($1) as name', [table])).rows[0]?.name) continue
    // Conservatively block background data operations; they may target this database indirectly.
    const column = table.endsWith('schedules') || table === 'cron_jobs' ? 'last_status' : 'status'
    if ((await manager.query(`select 1 from ${table} where ${column} in ('queued','running','validating') limit 1`)).rows.length) blockers.push(`Wait for the current ${table.replaceAll('_', ' ')} operation to finish.`)
  }
  return { ...usage, plan: { database: t.database, server: t.connection.name, apps: usage.apps, sessions, blockers } satisfies RenamePlan }
}

export async function planDatabaseRename(id: string) {
  await ensureDatabaseRenameSchema()
  const t = await target(id)
  await t.client.connect()
  try { return (await review(t, { query })).plan } finally { await t.client.end() }
}

/** No app files, processes, credentials or database contents are changed. */
export async function renameDatabase(id: string, newName: unknown, confirm: unknown, acknowledge: unknown, userId?: string) {
  await ensureDatabaseRenameSchema()
  const t = await target(id)
  const invalid = renameNameError(newName, t.database)
  if (invalid) throw new ApiError(invalid, 400)
  const name = newName as string
  if (isProtectedDatabase(name, t.control, t.system)) throw new ApiError('This database name is protected.', 400)
  if (confirm !== t.database || acknowledge !== true) throw new ApiError('Type the current database name and acknowledge updating every app connection.', 400)
  const manager = await db.connect()
  const locks: string[] = []
  let connected = false, managerTransaction = false, remoteTransaction = false, remoteCommitAttempted = false, jobId: string | undefined
  try {
    const locked = (await manager.query(`select pg_try_advisory_lock(hashtext('manager-storage-rename')) as locked`)).rows[0].locked
    if (!locked) throw new ApiError('Another database rename is running.', 409)
    locks.push('storage')
    await t.client.connect(); connected = true
    const { services, plan } = await review(t, manager)
    if (plan.blockers.length) throw new ApiError(plan.blockers.join(' '), 409)
    for (const projectId of [...new Set(plan.apps.map(app => app.projectId))].sort()) {
      if (!(await manager.query(`select pg_try_advisory_lock(hashtext('manager-project'),hashtext($1)) as locked`, [projectId])).rows[0].locked) throw new ApiError('Another operation is running for an affected application.', 409)
      locks.push(projectId)
    }
    // Recheck admission after obtaining app locks; the review is never authorization to use stale state.
    if ((await manager.query(`select id from deployments where project_id=any($1::uuid[]) and status in ('queued','running') limit 1`, [plan.apps.map(app => app.projectId)])).rows.length) throw new ApiError('An affected application is deploying.', 409)
    if ((await t.client.query('select 1 from pg_database where datname=$1', [name])).rows.length) throw new ApiError('That database name already exists on this server.', 409)
    jobId = (await manager.query<{ id: string }>(`insert into database_renames(connection_id,old_name,new_name,apps,created_by) values($1,$2,$3,$4,$5) returning id`,
      [t.connection.id, t.database, name, JSON.stringify(plan.apps), userId || null])).rows[0].id
    await manager.query('begin'); managerTransaction = true
    await t.client.query('begin'); remoteTransaction = true
    await t.client.query(`alter database ${quoteIdent(t.database)} rename to ${quoteIdent(name)}`)
    const updated = await manager.query(`update project_data_services set database_name=$1,updated_at=now() where id=any($2::uuid[]) and database_name=$3 returning id`, [name, services.map(service => service.id), t.database])
    if (updated.rows.length !== services.length) throw new ApiError('Database links changed while renaming. Refresh and try again.', 409)
    if (t.system && (await manager.query("select to_regclass('backup_schedules') as name")).rows[0]?.name) {
      await manager.query('update backup_schedules set database_name=$1 where database_name=$2', [name, t.database])
    }
    await manager.query(`update database_renames set status='succeeded',finished_at=now() where id=$1`, [jobId])
    await manager.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)', [userId || null, 'database.rename', id, JSON.stringify({ oldName: t.database, newName: name, apps: plan.apps })])
    remoteCommitAttempted = true
    await t.client.query('commit'); remoteTransaction = false
    await manager.query('commit'); managerTransaction = false
    return { database: name, apps: plan.apps, message: `Renamed ${t.database} to ${name}. Update saved environment files and connection settings for every app, worker and external client, then restart or redeploy them. Manager Storage links and backup schedules were updated; .env files were not changed.` }
  } catch (error) {
    if (remoteTransaction) await t.client.query('rollback').catch(() => undefined)
    if (managerTransaction) await manager.query('rollback').catch(() => undefined)
    if (jobId) await manager.query(`update database_renames set status=$2,error=$3,finished_at=now() where id=$1`,
      [jobId, remoteCommitAttempted ? 'needs_review' : 'failed', remoteCommitAttempted ? 'Commit result uncertain. Inspect the database name and Manager links before retrying.' : 'Rename failed; the database transaction was rolled back.']).catch(() => undefined)
    if (remoteCommitAttempted) throw new ApiError('Rename commit could not be verified. Inspect the old and new database names and Manager links before retrying; see rename history.', 500)
    if ((error as { code?: string }).code === '55006') throw new ApiError('The database still has active connections. Stop apps and workers and close database clients, then retry. Nothing was renamed.', 409)
    throw error
  } finally {
    for (const lock of locks.reverse()) {
      await manager.query(lock === 'storage' ? `select pg_advisory_unlock(hashtext('manager-storage-rename'))` : `select pg_advisory_unlock(hashtext('manager-project'),hashtext($1))`, lock === 'storage' ? [] : [lock]).catch(() => undefined)
    }
    manager.release(true)
    await t.client.end().catch(() => undefined)
  }
}
