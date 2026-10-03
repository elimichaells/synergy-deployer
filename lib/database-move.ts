import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, statfs, writeFile } from 'fs/promises'
import path from 'path'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { ApiError } from '@/lib/api'
import { encryptSecret } from '@/lib/secret-crypto'
import { connectionPassword, getSecretConnection, listDataConnections } from '@/lib/data-services'
import { databaseKey } from '@/lib/database-discovery-policy'
import { quoteIdent, roleNameFor } from '@/lib/dedicated-user-policy'
import { compareCopies, estimateMoveMinutes, filterRestoreList, moveTargetName, rewriteEnvLocation, type CopyFacts } from '@/lib/database-move-policy'
import { discoverDatabases, getStorageDatabase } from '@/lib/storage'
import { backupsRoot, envBackupDir, postgresBin } from '@/lib/paths'
import type { WorkerRecord } from '@/lib/workers'

/**
 * Moves a PostgreSQL database to another server on this machine, with its own limited login.
 * The apps that use it are stopped while an exact copy is made and checked; their env files are
 * then pointed at the copy and they are started again. If anything fails, the apps go back to the
 * original database, which is never changed. The copy files are kept as a backup.
 */

const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local']
const APP_NAME = 'synergy-manager-move'

export interface MovePlan {
  serviceId: string
  database: string
  sizeBytes: number
  source: { connectionId: string; name: string; port: number; version: string | null }
  target: { connectionId: string; name: string; port: number; version: string | null } | null
  targetDatabase: string
  roleName: string
  extensions: { name: string; schema: string }[]
  apps: { projectId: string; name: string; environment: string; pm2Name: string; running: boolean; username: string; files: { file: string; changes: number }[] }[]
  connections: { login: string; application: string; count: number }[]
  minutes: { low: number; high: number }
  blockers: string[]
  notes: string[]
}

async function withClient<T>(connectionId: string, database: string, fn: (client: import('pg').Client) => Promise<T>) {
  const connection = await getSecretConnection(connectionId)
  const { Client } = await import('pg')
  const client = new Client({ host: connection.host, port: connection.port, database, user: connection.username || undefined, password: connectionPassword(connection),
    ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000, application_name: APP_NAME })
  await client.connect()
  try { return await fn(client) } finally { await client.end().catch(() => undefined) }
}

const majorOf = (version: string | null) => version ? Number(version.split('.')[0]) : 0

async function toolVersion(executable: string) {
  const result = await runCommand({ file: executable, args: ['--version'] }, undefined, 15_000, undefined, undefined, true)
  return /(\d+)(\.\d+)?/.exec(result.output)?.[0] ?? null
}

async function pm2Online() {
  const result = await runCommand('pm2 jlist', undefined, 30_000)
  if (result.code) return new Set<string>()
  try {
    return new Set((JSON.parse(result.output.slice(result.output.indexOf('['))) as { name: string; pm2_env?: { status?: string } }[]).filter(item => item.pm2_env?.status === 'online').map(item => item.name))
  } catch { return new Set<string>() }
}

export async function ensureDatabaseMoveSchema() {
  await query(`create table if not exists database_moves (
    id uuid primary key default gen_random_uuid(),
    service_id text not null, database_name text not null, target_database text,
    source_connection_id uuid, target_connection_id uuid, role_name text,
    status text not null default 'running', log text not null default '', error text, copy_path text,
    created_by uuid, started_at timestamptz not null default now(), finished_at timestamptz)`)
  // Scheduled jobs of these apps do not start while their database moves.
  await query('alter table database_moves add column if not exists project_ids uuid[] not null default array[]::uuid[]')
}

export async function planDatabaseMove(serviceId: string, targetConnectionId?: string): Promise<MovePlan> {
  const database = await getStorageDatabase(serviceId)
  const blockers: string[] = []
  const notes: string[] = []
  const plan: MovePlan = {
    serviceId: database.id, database: database.database, sizeBytes: database.sizeBytes ?? 0,
    source: { connectionId: database.serverId, name: database.serverName, port: database.port, version: null }, target: null,
    targetDatabase: database.database, roleName: '', extensions: [], apps: [], connections: [], minutes: estimateMoveMinutes(database.sizeBytes ?? 0), blockers, notes,
  }
  if (database.engine !== 'postgresql') { blockers.push('Moving is available for PostgreSQL databases'); return plan }
  if (database.serverRole === 'external') { blockers.push('Synergy has no admin access to this server'); return plan }

  const candidates = (await listDataConnections()).filter(item => item.provider === 'postgresql' && item.id !== database.serverId
    && ['127.0.0.1', 'localhost', '::1'].includes(String(item.host).toLowerCase()) && !item.options?.system)
  const target = targetConnectionId ? candidates.find(item => item.id === targetConnectionId) : candidates.find(item => item.provisioning_enabled) ?? candidates[0]
  if (!target) { blockers.push('There is no other PostgreSQL server on this machine to move to'); return plan }

  // Facts from both servers.
  const source = await withClient(database.serverId, database.database, async client => ({
    version: (await client.query<{ v: string }>("select current_setting('server_version') as v")).rows[0].v,
    extensions: (await client.query<{ name: string; schema: string }>("select e.extname as name, n.nspname as schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname <> 'plpgsql' order by 1")).rows,
    connections: (await client.query<{ login: string; application: string; count: number }>(
      `select coalesce(usename,'-') as login, coalesce(nullif(application_name,''),'(unnamed)') as application, count(*)::int as count
       from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and application_name <> $1 group by 1,2 order by count desc`, [APP_NAME])).rows,
  }))
  const destination = await withClient(target.id, 'postgres', async client => ({
    version: (await client.query<{ v: string }>("select current_setting('server_version') as v")).rows[0].v,
    available: new Set((await client.query<{ name: string }>('select name from pg_available_extensions')).rows.map(row => row.name)),
    roles: new Set((await client.query<{ rolname: string }>('select rolname from pg_roles')).rows.map(row => row.rolname)),
    databases: new Set((await client.query<{ datname: string }>('select datname from pg_database')).rows.map(row => row.datname)),
    superuser: (await client.query<{ rolsuper: boolean }>('select rolsuper from pg_roles where rolname = current_user')).rows[0]?.rolsuper ?? false,
  }))
  plan.source.version = source.version
  plan.target = { connectionId: target.id, name: target.name, port: Number(target.port), version: destination.version }
  plan.extensions = source.extensions
  plan.connections = source.connections
  plan.roleName = roleNameFor(database.database, destination.roles)
  plan.targetDatabase = moveTargetName(database.database, destination.databases)

  if (majorOf(destination.version) < majorOf(source.version)) blockers.push(`${target.name} runs PostgreSQL ${destination.version}, older than this database's ${source.version}`)
  const missing = source.extensions.filter(extension => !destination.available.has(extension.name))
  if (missing.length) blockers.push(`${target.name} does not have these extensions installed: ${missing.map(item => item.name).join(', ')}`)
  if (!destination.superuser && source.extensions.length) blockers.push(`Synergy's login on ${target.name} cannot create extensions`)

  const bin = postgresBin()
  const dump = bin ? path.join(bin, 'pg_dump.exe') : ''
  const restore = bin ? path.join(bin, 'pg_restore.exe') : ''
  if (!bin || !existsSync(dump) || !existsSync(restore)) blockers.push('pg_dump and pg_restore were not found; install the PostgreSQL tools')
  else if (majorOf(await toolVersion(dump)) < majorOf(source.version)) blockers.push(`pg_dump is older than the database server (${source.version}); update the PostgreSQL tools`)

  try {
    await mkdir(backupsRoot(), { recursive: true })
    const space = await statfs(backupsRoot())
    const free = space.bavail * space.bsize
    if (free < plan.sizeBytes * 2 + 1024 ** 3) blockers.push(`Not enough free disk space for the copy (${Math.round(free / 1024 ** 3)} GB free)`)
  } catch { notes.push('Free disk space could not be checked') }

  const key = databaseKey('postgresql', database.host, database.port, database.database)
  const unlinked = (await discoverDatabases()).filter(item => !item.linked && databaseKey(item.engine, item.host, item.port, item.database) === key)
  if (unlinked.length) blockers.push(`Link ${[...new Set(unlinked.map(item => item.projectName))].join(', ')} to this database first, so ${unlinked.length === 1 ? 'it moves' : 'they move'} too`)
  const running = await query<{ name: string }>(`select distinct p.name from deployments d join projects p on p.id=d.project_id where d.status in ('queued','running') and d.project_id = any($1::uuid[])`, [database.apps.map(app => app.projectId)])
  if (running.rows.length) blockers.push(`Wait for the running deployment of ${running.rows.map(row => row.name).join(', ')} to finish`)
  const active = await query<{ id: string }>("select id from database_moves where status = 'running' limit 1").catch(() => ({ rows: [] as { id: string }[] }))
  if (active.rows.length) blockers.push('Another database move is running; wait for it to finish')

  const online = await pm2Online()
  for (const app of database.apps) {
    const { rows } = await query<{ root_path: string; pm2_name: string }>('select root_path, pm2_name from projects where id=$1', [app.projectId])
    const files: { file: string; changes: number }[] = []
    for (const file of ENV_FILES) {
      const full = path.join(rows[0]?.root_path || '', file)
      if (!rows[0] || !existsSync(full)) continue
      const { changed } = rewriteEnvLocation(await readFile(full, 'utf8'), { host: database.host, port: database.port, database: database.database, username: app.username || '' },
        { host: '127.0.0.1', port: plan.target.port, database: plan.targetDatabase, username: plan.roleName, password: 'placeholder' })
      if (changed) files.push({ file, changes: changed })
    }
    if (!files.length) blockers.push(`Couldn't find ${app.name}'s database settings in its .env files`)
    plan.apps.push({ projectId: app.projectId, name: app.name, environment: app.environment, pm2Name: rows[0]?.pm2_name ?? '', running: online.has(rows[0]?.pm2_name ?? ''), username: app.username || '', files })
  }

  const names = plan.apps.map(app => app.name).join(', ')
  if (new Set(plan.apps.map(app => app.environment)).size > 1) notes.push('Staging and production share this database, so both move and both are stopped during the copy.')
  notes.push(`${names} ${plan.apps.length === 1 ? 'is' : 'are'} stopped for about ${plan.minutes.low} to ${plan.minutes.high} minutes while the data is copied and checked.`)
  notes.push(`The original database on ${database.serverName} is not changed or deleted. Remove it from Storage once you are happy with the move.`)
  notes.push('The copy files are kept under the backups folder as a backup taken just before the move.')
  if (source.connections.length) notes.push(`Right now ${source.connections.reduce((sum, item) => sum + item.count, 0)} connection(s) are open to it; anything still connected after the apps stop makes the move stop safely.`)
  return plan
}

// ─── The move itself ───────────────────────────────────────────────────────────

export interface MoveJob { id: string; service_id: string; database_name: string; target_database: string | null; status: string; log: string; error: string | null; copy_path: string | null; started_at: string; finished_at: string | null }

export async function getDatabaseMove(id: string) {
  await ensureDatabaseMoveSchema()
  const { rows } = await query<MoveJob>('select id, service_id, database_name, target_database, status, log, error, copy_path, started_at, finished_at from database_moves where id = $1', [id])
  return rows[0] ?? null
}

export async function latestDatabaseMove(serviceId: string) {
  await ensureDatabaseMoveSchema()
  const { rows } = await query<MoveJob>('select id, service_id, database_name, target_database, status, log, error, copy_path, started_at, finished_at from database_moves where service_id = $1 order by started_at desc limit 1', [serviceId])
  return rows[0] ?? null
}

export async function startDatabaseMove(serviceId: string, targetConnectionId: string | undefined, confirmedDatabase: unknown, userId: string | null | undefined) {
  await ensureDatabaseMoveSchema()
  const plan = await planDatabaseMove(serviceId, targetConnectionId)
  if (plan.blockers.length) throw new ApiError(plan.blockers.join(' '), 409)
  if (confirmedDatabase !== plan.database) throw new ApiError('Type the database name to confirm the move', 400)
  const { rows } = await query<{ id: string }>(
    `insert into database_moves (service_id, database_name, target_database, source_connection_id, target_connection_id, role_name, created_by, project_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) returning id`,
    [serviceId, plan.database, plan.targetDatabase, plan.source.connectionId, plan.target!.connectionId, plan.roleName, userId || null, plan.apps.map(app => app.projectId)])
  const id = rows[0].id
  setImmediate(() => void runMove(id, plan, userId).catch(error => console.error('[move] failed unexpectedly:', error)))
  return { id }
}

export async function recoverInterruptedMoves() {
  await ensureDatabaseMoveSchema()
  await query(`update database_moves set status = 'interrupted', finished_at = now(),
    error = 'Synergy restarted during the move. Check that the apps are running; the original database was not changed.' where status = 'running'`)
}

async function runMove(id: string, plan: MovePlan, userId: string | null | undefined) {
  const log = async (line: string) => { await query('update database_moves set log = log || $2 where id = $1', [id, `${new Date().toISOString().slice(11, 19)}  ${line}\n`]) }
  const database = await getStorageDatabase(plan.serviceId)
  const target = plan.target!
  const sourceSecret = await getSecretConnection(plan.source.connectionId)
  const targetSecret = await getSecretConnection(target.connectionId)
  const bin = postgresBin()!
  const password = randomBytes(24).toString('base64url')
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
  const copyDir = path.join(backupsRoot(), 'database-moves', `${plan.database}-${stamp}`)
  const releases: (() => Promise<void>)[] = []
  const stopped: MovePlan['apps'] = []
  const stoppedWorkers: WorkerRecord[] = []
  const startWorkers = async () => {
    if (!stoppedWorkers.length) return
    const { controlWorker } = await import('@/lib/workers')
    for (const worker of stoppedWorkers) {
      try { await controlWorker(worker, 'start'); await log(`Resumed the worker ${worker.name}`) } catch (error) { await log(`The worker ${worker.name} could not be resumed: ${(error as Error).message}`) }
    }
  }
  const envBackups: { full: string; original: string }[] = []
  let targetCreated = false

  const pgEnv = (secret: { password_ciphertext: string | null }) => ({ PGPASSWORD: connectionPassword(secret as Parameters<typeof connectionPassword>[0]), PGAPPNAME: APP_NAME, PGCONNECT_TIMEOUT: '15' })
  const dropTarget = async () => {
    if (!targetCreated) return
    await withClient(target.connectionId, 'postgres', async client => {
      await client.query(`drop database if exists ${quoteIdent(plan.targetDatabase)} with (force)`)
      await client.query(`drop role if exists ${quoteIdent(plan.roleName)}`)
    })
    await log(`Removed the unfinished copy from ${target.name}`)
  }
  const startApps = async (label: string) => {
    if (!stopped.length) return
    const { restartWithFreshEnvironment } = await import('@/lib/deploy')
    for (const app of stopped) {
      const result = await restartWithFreshEnvironment(app.projectId).catch(error => ({ healthy: false, reason: (error as Error).message }))
      await log(`${label}: ${app.name} ${result.healthy ? 'is running and healthy' : `did not come back healthy (${result.reason})`}`)
    }
  }
  // Each step runs even if an earlier one fails, so the apps always get their original settings
  // back and an unfinished copy never stays behind.
  const rollBack = async (reason: string) => {
    const attempt = async (label: string, work: () => Promise<unknown>) => { try { await work() } catch (error) { await log(`${label} failed: ${(error as Error).message}`).catch(() => undefined) } }
    await attempt('Logging', () => log(`Stopping the move: ${reason}`))
    await attempt('Restoring env files', async () => {
      for (const backup of envBackups) await writeFile(backup.full, backup.original, 'utf8')
      if (envBackups.length) await log('Put the apps\' env files back as they were')
    })
    await attempt('Restarting apps', () => startApps('Back on the original database'))
    await attempt('Resuming workers', startWorkers)
    await attempt('Removing the unfinished copy', dropTarget)
    await query(`update database_moves set status = 'rolled_back', error = $2, finished_at = now() where id = $1`, [id, reason])
    await query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null, 'storage.move-rolled-back', `service:${plan.serviceId}`, { database: plan.database, reason }]).catch(() => undefined)
  }

  try {
    const { acquireProjectOperation } = await import('@/lib/project-operation')
    for (const app of plan.apps) releases.push(await acquireProjectOperation(app.projectId))
    await log(`Moving ${plan.database} (${Math.round(plan.sizeBytes / 1048576)} MB) from ${plan.source.name} to ${target.name} as ${plan.targetDatabase}`)

    // 1. An empty database on the target, owned by its own limited login, with the same extensions.
    await withClient(target.connectionId, 'postgres', async client => {
      await client.query(`CREATE ROLE ${quoteIdent(plan.roleName)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`)
      targetCreated = true
      await client.query(`CREATE DATABASE ${quoteIdent(plan.targetDatabase)} OWNER ${quoteIdent(plan.roleName)}`)
    })
    await withClient(target.connectionId, plan.targetDatabase, async client => {
      for (const extension of plan.extensions) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(extension.schema)}`)
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension.name)} WITH SCHEMA ${quoteIdent(extension.schema)}`)
      }
    })
    await log(`Created ${plan.targetDatabase} on ${target.name}, owned by the new login ${plan.roleName}${plan.extensions.length ? `, with ${plan.extensions.map(item => item.name).join(', ')}` : ''}`)

    // 2. Let any scheduled job of these apps finish; new ones do not start while the move runs.
    const ids = plan.apps.map(app => app.projectId)
    const cronDeadline = Date.now() + 120_000
    while (true) {
      const { rows: busy } = await query<{ name: string }>(`select c.name from cron_jobs c where c.last_status = 'running'
        and (c.project_id = any($1::uuid[]) or exists (select 1 from projects p where p.id = any($1::uuid[]) and lower(p.root_path) = lower(c.working_directory)))`, [ids])
        .catch(() => ({ rows: [] as { name: string }[] }))
      if (!busy.length) break
      if (Date.now() > cronDeadline) { await rollBack(`The scheduled job "${busy[0].name}" is still running after two minutes. Nothing was copied.`); return }
      await new Promise(resolve => setTimeout(resolve, 5000))
    }

    // 3. Stop every app that uses it and its background workers, then make sure nothing else is still connected.
    for (const app of plan.apps.filter(item => item.running)) {
      const result = await runCommand(`pm2 stop "${app.pm2Name}"`, undefined, 60_000)
      if (result.code) throw new Error(`${app.name} could not be stopped`)
      stopped.push(app)
      await log(`Stopped ${app.name}`)
    }
    const online = await pm2Online()
    for (const app of plan.apps) {
      const { rows } = await query<WorkerRecord>(`select w.* from workers w join projects p on lower(p.root_path) = lower(w.working_directory) where p.id = $1`, [app.projectId]).catch(() => ({ rows: [] as WorkerRecord[] }))
      for (const worker of rows.filter(item => online.has(item.pm2_name))) {
        if ((await runCommand(`pm2 stop "${worker.pm2_name}"`, undefined, 60_000)).code) throw new Error(`The worker ${worker.name} could not be stopped`)
        stoppedWorkers.push(worker)
        await log(`Paused the worker ${worker.name}`)
      }
    }
    const deadline = Date.now() + 30_000
    let remaining: { login: string; application: string; count: number }[] = []
    while (true) {
      remaining = await withClient(plan.source.connectionId, plan.database, async client => {
        // The manager's own database browser lets go immediately; anything else must close by itself.
        await client.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'synergy-manager' and pid <> pg_backend_pid()`)
        return (await client.query<{ login: string; application: string; count: number }>(
          `select coalesce(usename,'-') as login, coalesce(nullif(application_name,''),'(unnamed)') as application, count(*)::int as count
           from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and application_name <> $1 group by 1,2`, [APP_NAME])).rows
      })
      if (!remaining.length || Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (remaining.length) {
      await rollBack(`Something other than the apps is still connected to ${plan.database} (${remaining.map(item => `${item.count} from ${item.login} / ${item.application}`).join(', ')}). Nothing was copied.`)
      return
    }
    await log('No connections remain to the original database')

    // 4. An exact copy, made while nothing writes to it.
    await mkdir(path.dirname(copyDir), { recursive: true })
    await query('update database_moves set copy_path = $2 where id = $1', [id, copyDir])
    const dump = await runCommand({ file: path.join(bin, 'pg_dump.exe'), args: ['-h', sourceSecret.host, '-p', String(sourceSecret.port), '-U', sourceSecret.username || 'postgres',
      '-d', plan.database, '-Fd', '-j', '4', '-f', copyDir, '--no-password'] }, undefined, 4 * 3600_000, undefined, pgEnv(sourceSecret), true)
    if (dump.code) { await rollBack(`The copy could not be made: ${dump.output.trim().split(/\r?\n/).slice(-2).join(' ')}`); return }
    await log(`Copied the data to ${copyDir}`)

    const listed = await runCommand({ file: path.join(bin, 'pg_restore.exe'), args: ['-l', copyDir] }, undefined, 300_000, undefined, undefined, true)
    if (listed.code) { await rollBack('The copy could not be read back'); return }
    const listFile = `${copyDir}.list`
    await writeFile(listFile, filterRestoreList(listed.output), 'utf8')
    const restore = await runCommand({ file: path.join(bin, 'pg_restore.exe'), args: ['-h', targetSecret.host, '-p', String(targetSecret.port), '-U', targetSecret.username || 'postgres',
      '-d', plan.targetDatabase, '--no-owner', '--no-acl', `--role=${plan.roleName}`, '-j', '4', '--exit-on-error', '-L', listFile, '--no-password', copyDir] },
      undefined, 4 * 3600_000, undefined, pgEnv(targetSecret), true)
    if (restore.code) { await rollBack(`The copy could not be loaded into ${target.name}: ${restore.output.trim().split(/\r?\n/).slice(-2).join(' ')}`); return }
    await log(`Loaded the copy into ${plan.targetDatabase}`)

    // 5. Prove the copy is exact before any app uses it.
    const [sourceFacts, targetFacts] = await Promise.all([
      withClient(plan.source.connectionId, plan.database, copyFacts),
      withClient(target.connectionId, plan.targetDatabase, copyFacts),
    ])
    const differences = compareCopies(sourceFacts, targetFacts)
    if (differences.length) { await rollBack(`The copy does not match the original: ${differences.slice(0, 5).join('; ')}`); return }
    const foreign = await withClient(target.connectionId, plan.targetDatabase, async client => (await client.query<{ count: number }>(
      `select count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and c.relkind in ('r','p','v','m','S','f') and pg_get_userbyid(c.relowner) <> $1
         and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`, [plan.roleName])).rows[0].count)
    if (foreign) { await rollBack(`${foreign} objects in the copy are not owned by ${plan.roleName}`); return }
    await log(`Checked the copy: ${Object.keys(sourceFacts.rows).length} tables with identical row counts, ${Object.keys(sourceFacts.sequences).length} sequences at the same values, all owned by ${plan.roleName}`)

    // 6. Point each app at the copy, keeping every original env file.
    const backupStamp = new Date().toISOString().replace(/[-:.]/g, '')
    for (const app of plan.apps) {
      const { rows } = await query<{ root_path: string }>('select root_path from projects where id=$1', [app.projectId])
      const backupDirectory = path.join(envBackupDir(), app.projectId)
      await mkdir(backupDirectory, { recursive: true })
      for (const { file } of app.files) {
        const full = path.join(rows[0].root_path, file)
        const original = await readFile(full, 'utf8')
        await copyFile(full, path.join(backupDirectory, `${file.replace(/^\./, '')}-${backupStamp}-before-move.bak`))
        const updated = rewriteEnvLocation(original, { host: database.host, port: database.port, database: database.database, username: app.username },
          { host: '127.0.0.1', port: target.port, database: plan.targetDatabase, username: plan.roleName, password })
        await writeFile(full, updated.content, 'utf8')
        envBackups.push({ full, original })
      }
    }
    await log(`Updated ${envBackups.length} env file(s); originals saved under ${envBackupDir()}`)

    // 7. Start the apps on the copy; any unhealthy app sends everything back.
    const restart = stopped.length ? (await import('@/lib/deploy')).restartWithFreshEnvironment : null
    for (const app of stopped) {
      const result = await restart!(app.projectId)
      if (!result.healthy) {
        await rollBack(`${app.name} did not come back healthy on the moved database (${result.reason})`)
        return
      }
      await log(`Started ${app.name} on the moved database; it is healthy`)
    }

    await startWorkers()

    // 8. Synergy now tracks the database at its new home with its new login.
    await query(`update project_data_services set connection_id = $1, database_name = $2, username = $3, password_ciphertext = $4, updated_at = now()
      where connection_id = $5 and database_name = $6`, [target.connectionId, plan.targetDatabase, plan.roleName, encryptSecret(password), plan.source.connectionId, plan.database])
    await query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null, 'storage.moved', `service:${plan.serviceId}`,
      { database: plan.database, from: plan.source.name, to: target.name, targetDatabase: plan.targetDatabase, role: plan.roleName, apps: plan.apps.map(app => app.name), copy: copyDir }])
    await log(`Done. ${plan.database} on ${plan.source.name} is unchanged; remove it from Storage once you are happy.`)
    await query(`update database_moves set status = 'succeeded', finished_at = now() where id = $1`, [id])
  } catch (error) {
    await rollBack((error as Error).message || String(error)).catch(async inner => {
      await query(`update database_moves set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, `${(error as Error).message}; then ${(inner as Error).message}`])
    })
  } finally {
    for (const release of releases) await release().catch(() => undefined)
  }
}

/** Exact row counts, sequence positions and object counts for one database. */
async function copyFacts(client: import('pg').Client): Promise<CopyFacts> {
  const user = `n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`
  const notExtension = (catalog: string, column: string) => `not exists (select 1 from pg_depend d where d.classid='${catalog}'::regclass and d.objid=${column} and d.deptype='e')`
  const tables = (await client.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where ${user} and c.relkind in ('r','p') and ${notExtension('pg_class', 'c.oid')} order by 1,2`)).rows
  const rows: Record<string, number> = {}
  for (const table of tables) {
    rows[`${table.schema}.${table.name}`] = Number((await client.query<{ count: string }>(`select count(*) as count from ${quoteIdent(table.schema)}.${quoteIdent(table.name)}`)).rows[0].count)
  }
  const sequences = Object.fromEntries((await client.query<{ name: string; value: string | null }>(
    `select schemaname || '.' || sequencename as name, last_value::text as value from pg_sequences where schemaname !~ '^pg_' and schemaname <> 'information_schema'`)).rows
    .map(row => [row.name, row.value === null ? null : Number(row.value)]))
  const objects = (await client.query<{ kind: string; count: number }>(`
    select 'views' as kind, count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${user} and c.relkind in ('v','m') and ${notExtension('pg_class', 'c.oid')}
    union all select 'indexes', count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${user} and c.relkind = 'i' and ${notExtension('pg_class', 'c.oid')}
    union all select 'functions', count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${user} and ${notExtension('pg_proc', 'p.oid')}
    union all select 'types', count(*)::int from pg_type t join pg_namespace n on n.oid=t.typnamespace where ${user} and t.typtype in ('e','d','c') and t.typrelid = 0 and ${notExtension('pg_type', 't.oid')}
    union all select 'triggers', count(*)::int from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace where ${user} and not tg.tgisinternal`)).rows
  return { rows, sequences, objects: Object.fromEntries(objects.map(row => [row.kind, row.count])) }
}
