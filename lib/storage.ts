import { existsSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import path from 'path'
import { parse as parseEnv } from 'dotenv'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'
import {
  ensureDataServicesSchema, envPrefix, getSecretConnection, connectionPassword, safeName, testProjectServiceCredential,
  type SecretConnection,
} from '@/lib/data-services'
import { databaseKey, hostKey, parseDatabaseEnv, uniqueDatabases, type DiscoveredDatabase } from '@/lib/database-discovery-policy'

// Storage: every database apps use, whether Synergy created it, it was shared in a
// project, or an app already pointed at it in its own .env before Synergy knew.

const ENV_FILES = ['.env.local', '.env.production', '.env']
const SYSTEM_NAME = 'Synergy system PostgreSQL'

interface ConnectionRow { id: string; name: string; provider: string; host: string; port: number; username: string | null; options: Record<string, unknown>; purpose: string; managed: boolean; provisioning_enabled: boolean; last_status: string }

/**
 * Registers the PostgreSQL server that holds Synergy's own control database, so the
 * app databases living beside it can be seen and linked. New databases are never
 * created there (provisioning stays off); it is reserved for Synergy.
 */
let systemServer: Promise<string> | undefined
export function ensureSystemServer() {
  return systemServer ??= (async () => {
    await ensureDataServicesSchema()
    const existing = await query<{ id: string }>(`select id from data_connections where options->>'system'='true' limit 1`)
    if (existing.rows[0]) return existing.rows[0].id
    const password = process.env.DATABASE_PASSWORD || ''
    const { rows } = await query<{ id: string }>(
      `insert into data_connections (name,provider,host,port,username,password_ciphertext,tls_enabled,options,purpose,managed,is_default,provisioning_enabled,last_status,last_tested_at)
       values ($1,'postgresql',$2,$3,$4,$5,false,$6,'shared_application',true,false,false,'healthy',now())
       on conflict (name) do update set options=data_connections.options || '{"system":true}'::jsonb returning id`,
      [SYSTEM_NAME, process.env.DATABASE_HOST || '127.0.0.1', Number(process.env.DATABASE_PORT || 5432), process.env.DATABASE_USER || 'postgres',
        password ? encryptSecret(password) : null, { system: true, database: 'postgres' }])
    return rows[0].id
  })().catch(error => { systemServer = undefined; throw error })
}

async function connections() {
  await ensureSystemServer()
  const { rows } = await query<ConnectionRow>('select id,name,provider,host,port,username,options,purpose,managed,provisioning_enabled,last_status from data_connections')
  return rows
}

function matchConnection(list: ConnectionRow[], item: Pick<DiscoveredDatabase, 'engine' | 'host' | 'port'>) {
  const same = (provider: string) => provider === item.engine || (['mysql', 'mariadb'].includes(provider) && ['mysql', 'mariadb'].includes(item.engine))
  return list.find(connection => same(connection.provider) && hostKey(connection.host) === hostKey(item.host) && connection.port === item.port)
}

async function readAppEnv(rootPath: string) {
  const found: DiscoveredDatabase[] = []
  for (const file of ENV_FILES) {
    const full = path.join(rootPath, file)
    if (!existsSync(full)) continue
    try { found.push(...parseDatabaseEnv(file, parseEnv(await readFile(full)))) } catch { /* unreadable env files are skipped */ }
  }
  return uniqueDatabases(found)
}

export interface DiscoveryItem {
  projectId: string
  projectName: string
  environment: string
  productionId: string | null
  source: string
  engine: string
  host: string
  port: number
  database: string
  username: string | null
  connectionId: string | null
  connectionName: string | null
  systemServer: boolean
  external: boolean
  linked: boolean
  superuser: boolean
  usedBy: string[]
  sharedWithProduction: boolean
}

/** Databases each app points at in its env files, and whether Synergy already knows them. */
export async function discoverDatabases(projectId?: string) {
  const list = await connections()
  const projects = await query<{ id: string; name: string; environment: string; production_id: string | null; root_path: string }>(
    `select id,name,environment,production_id,root_path from projects ${projectId ? 'where id=$1' : ''} order by name, environment`, projectId ? [projectId] : [])
  const linked = await query<{ project_id: string; key: string }>(
    `select s.project_id, dc.provider || '|' || dc.host || '|' || dc.port || '|' || s.database_name as key from project_data_services s join data_connections dc on dc.id=s.connection_id`)
  const linkedKeys = new Set(linked.rows.map(row => { const [engine, host, port, database] = row.key.split('|'); return `${row.project_id}|${databaseKey(engine, host, Number(port), database)}` }))

  const raw: (DiscoveredDatabase & { project: (typeof projects.rows)[number] })[] = []
  for (const project of projects.rows) for (const item of await readAppEnv(project.root_path)) raw.push({ ...item, project })

  const superusers = await superuserNames(list)
  const usage = new Map<string, string[]>()
  for (const item of raw) {
    const key = databaseKey(item.engine, item.host, item.port, item.database)
    usage.set(key, [...(usage.get(key) || []), item.project.name])
  }
  return raw.map((item): DiscoveryItem => {
    const connection = matchConnection(list, item)
    const key = databaseKey(item.engine, item.host, item.port, item.database)
    const productionKey = item.project.production_id && raw.some(other => other.project.id === item.project.production_id && databaseKey(other.engine, other.host, other.port, other.database) === key)
    return {
      projectId: item.project.id, projectName: item.project.name, environment: item.project.environment, productionId: item.project.production_id,
      source: item.source, engine: item.engine, host: item.host, port: item.port, database: item.database, username: item.username,
      connectionId: connection?.id || null, connectionName: connection?.name || null, systemServer: connection?.options?.system === true,
      external: hostKey(item.host) !== 'local', linked: linkedKeys.has(`${item.project.id}|${key}`),
      superuser: !!item.username && (superusers.get(connection?.id || '')?.has(item.username) || (item.engine === 'postgresql' && item.username === 'postgres') || (['mysql', 'mariadb'].includes(item.engine) && item.username === 'root')),
      usedBy: (usage.get(key) || []).filter(name => name !== item.project.name),
      sharedWithProduction: !!productionKey,
    }
  })
}

async function superuserNames(list: ConnectionRow[]) {
  const result = new Map<string, Set<string>>()
  for (const connection of list.filter(item => item.provider === 'postgresql' && hostKey(item.host) === 'local')) {
    try {
      const rows = await adminQuery(connection.id, 'select rolname from pg_roles where rolsuper') as { rolname: string }[]
      result.set(connection.id, new Set(rows.map(row => row.rolname)))
    } catch { /* servers without admin access are skipped */ }
  }
  return result
}

/** Runs a read query with a server's admin account. PostgreSQL and MySQL only. */
async function adminQuery(connectionId: string, sql: string, params: unknown[] = [], database?: string): Promise<Record<string, unknown>[]> {
  const connection = await getSecretConnection(connectionId)
  const password = connectionPassword(connection)
  if (connection.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: connection.host, port: connection.port, user: connection.username || undefined, password, database: database || String(connection.options?.database || 'postgres'),
      ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 8000, statement_timeout: 15000 })
    await client.connect()
    try { return (await client.query(sql, params)).rows } finally { await client.end() }
  }
  if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.username || undefined, password, connectTimeout: 8000, ssl: connection.tls_enabled ? {} : undefined })
    try { const [rows] = await client.query(sql, params); return rows as Record<string, unknown>[] } finally { await client.end() }
  }
  throw new ApiError('This engine does not support server inspection yet', 409)
}

/** Links a database the app already uses (read from its env file) without changing anything in the app. */
export async function adoptDatabase(projectId: string, source: unknown, createdBy?: string | null) {
  if (typeof source !== 'string' || !source) throw new ApiError('Choose a database to link', 400)
  const { rows: projects } = await query<{ root_path: string }>('select root_path from projects where id=$1', [projectId])
  if (!projects[0]) throw new ApiError('Application not found', 404)
  const item = (await readAppEnv(projects[0].root_path)).find(candidate => candidate.source === source)
  if (!item) throw new ApiError('That database setting is no longer in the app\'s environment file', 404)
  const discovered = (await discoverDatabases(projectId)).find(candidate => candidate.source === source)
  if (discovered?.linked) throw new ApiError('This database is already linked to the app', 409)

  const list = await connections()
  let connection = matchConnection(list, item)
  if (!connection) {
    // A server Synergy has no admin access to (for example a hosted database): register it for reference only.
    const name = `${item.engine === 'postgresql' ? 'PostgreSQL' : item.engine} at ${item.host}${item.port ? `:${item.port}` : ''}`.slice(0, 120)
    const created = await query<ConnectionRow>(
      `insert into data_connections (name,provider,host,port,tls_enabled,options,purpose,managed,is_default,provisioning_enabled,last_status)
       values ($1,$2,$3,$4,$5,$6,'external_service',false,false,false,'untested')
       on conflict (name) do update set updated_at=now() returning id,name,provider,host,port,username,options,purpose,managed,provisioning_enabled,last_status`,
      [name, item.engine, item.host, item.port, item.tls, { discovered: true }])
    connection = created.rows[0]
  }
  const secret = await getSecretConnection(connection.id)
  try {
    await testProjectServiceCredential({ ...secret, tls_enabled: secret.tls_enabled || item.tls } as SecretConnection, item.database, item.username, item.password || '')
  } catch (error) {
    throw new ApiError(`Synergy could not sign in to ${item.database} with the app's credentials: ${(error as Error).message.slice(0, 300)}`, 400)
  }
  const existingPrefixes = new Set((await query<{ env_prefix: string; name: string }>('select env_prefix,name from project_data_services where project_id=$1', [projectId])).rows.flatMap(row => [row.env_prefix, row.name]))
  let prefix = envPrefix(item.database)
  let name = safeName(item.database, 40)
  for (let index = 2; existingPrefixes.has(prefix) || existingPrefixes.has(name); index++) { prefix = `${envPrefix(item.database)}_${index}`; name = safeName(`${item.database}_${index}`, 40) }
  const { rows } = await query<{ id: string }>(
    `insert into project_data_services (project_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,options,created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [projectId, connection.id, name, item.database, item.username, item.password ? encryptSecret(item.password) : null, prefix,
      { ownership: 'adopted', injectEnv: false, source, tls: item.tls }, createdBy || null])
  return { id: rows[0].id, database: item.database, connection: connection.name }
}

export interface StorageDatabase {
  key: string
  id: string
  name: string
  database: string
  engine: string
  serverId: string
  serverName: string
  serverRole: 'system' | 'apps' | 'external'
  host: string
  port: number
  sizeBytes: number | null
  ownership: string
  apps: { serviceId: string; projectId: string; name: string; environment: string; groupId: string | null; groupName: string | null; ownership: string; username: string | null }[]
  backup: BackupSummary | null
  warnings: string[]
}

function serverRole(connection: { options: Record<string, unknown>; purpose: string; host: string }): StorageDatabase['serverRole'] {
  if (connection.options?.system === true) return 'system'
  return connection.purpose === 'external_service' || hostKey(connection.host) !== 'local' ? 'external' : 'apps'
}

/** One entry per physical database, with every app that uses it. */
export interface BackupSummary {
  scheduleId: string; frequency: string; enabled: boolean; lastStatus: string; lastFinishedAt: string | null; nextRunAt: string | null
  timeOfDay: string; timezone: string; dayOfWeek: number; dayOfMonth: number; monthOfYear: number; retentionCount: number
}

function backupSummary(row: { schedule_id: string | null; frequency: string | null; enabled: boolean | null; last_status: string | null; last_finished_at: string | null; next_run_at: string | null; time_of_day: string | null; timezone: string | null; day_of_week: number | null; day_of_month: number | null; month_of_year: number | null; retention_count: number | null }): BackupSummary {
  return { scheduleId: row.schedule_id!, frequency: row.frequency!, enabled: !!row.enabled, lastStatus: row.last_status!, lastFinishedAt: row.last_finished_at, nextRunAt: row.next_run_at,
    timeOfDay: row.time_of_day || '03:00', timezone: row.timezone || 'UTC', dayOfWeek: row.day_of_week ?? 0, dayOfMonth: row.day_of_month ?? 1, monthOfYear: row.month_of_year ?? 1, retentionCount: row.retention_count ?? 30 }
}

export async function listStorage() {
  await ensureSystemServer()
  const { ensureDataServiceBackupSchema } = await import('@/lib/data-service-backups')
  await ensureDataServiceBackupSchema()
  const { rows } = await query<{
    id: string; project_id: string; name: string; database_name: string; username: string | null; options: Record<string, unknown>
    connection_id: string; connection_name: string; provider: string; host: string; port: number; connection_options: Record<string, unknown>; purpose: string
    project_name: string; environment: string; group_id: string | null; group_name: string | null
    schedule_id: string | null; frequency: string | null; enabled: boolean | null; last_status: string | null; last_finished_at: string | null; next_run_at: string | null
    time_of_day: string | null; timezone: string | null; day_of_week: number | null; day_of_month: number | null; month_of_year: number | null; retention_count: number | null
  }>(`select s.id,s.project_id,s.name,s.database_name,s.username,s.options,s.connection_id,dc.name as connection_name,dc.provider,dc.host,dc.port,
            dc.options as connection_options,dc.purpose,p.name as project_name,p.environment,g.id as group_id,g.name as group_name,
            bs.id as schedule_id,bs.frequency,bs.enabled,bs.last_status,bs.last_finished_at,bs.next_run_at,
            bs.time_of_day,bs.timezone,bs.day_of_week,bs.day_of_month,bs.month_of_year,bs.retention_count
       from project_data_services s join data_connections dc on dc.id=s.connection_id join projects p on p.id=s.project_id
       left join application_groups g on g.id=p.application_group_id left join data_service_backup_schedules bs on bs.service_id=s.id
      order by p.name`)
  const groups = new Map<string, StorageDatabase>()
  for (const row of rows) {
    const key = `${row.connection_id}|${row.database_name}`
    const app = { serviceId: row.id, projectId: row.project_id, name: row.project_name, environment: row.environment, groupId: row.group_id, groupName: row.group_name, ownership: String(row.options?.ownership || 'manager'), username: row.username }
    const existing = groups.get(key)
    // Prefer the owning record (created or linked) over a shared copy as the database's identity.
    if (existing) {
      existing.apps.push(app)
      if (existing.ownership === 'shared' && app.ownership !== 'shared') Object.assign(existing, { id: row.id, ownership: app.ownership })
      if (!existing.backup && row.schedule_id) existing.backup = backupSummary(row)
      continue
    }
    groups.set(key, {
      key, id: row.id, name: row.name, database: row.database_name, engine: row.provider, serverId: row.connection_id, serverName: row.connection_name,
      serverRole: serverRole({ options: row.connection_options, purpose: row.purpose, host: row.host }), host: row.host, port: row.port, sizeBytes: null,
      ownership: app.ownership, apps: [app],
      backup: row.schedule_id ? backupSummary(row) : null,
      warnings: [],
    })
  }
  const databases = [...groups.values()]
  await attachSizes(databases)
  const superusers = await superuserNames(await connections())
  for (const database of databases) {
    if (database.serverRole === 'system') database.warnings.push('Shares a server with Synergy\'s own database')
    if (database.apps.some(app => app.username && superusers.get(database.serverId)?.has(app.username))) database.warnings.push('An app connects with a superuser account')
    const environments = new Set(database.apps.map(app => app.environment))
    if (environments.has('production') && environments.has('staging')) database.warnings.push('Staging and production use the same database')
    if (!database.backup && database.engine === 'postgresql') database.warnings.push('No backup schedule')
  }
  return databases.sort((a, b) => a.database.localeCompare(b.database))
}

async function attachSizes(databases: StorageDatabase[]) {
  const byServer = new Map<string, StorageDatabase[]>()
  for (const database of databases) if (database.serverRole !== 'external') byServer.set(database.serverId, [...(byServer.get(database.serverId) || []), database])
  await Promise.all([...byServer.entries()].map(async ([serverId, list]) => {
    try {
      const engine = list[0].engine
      const rows = engine === 'postgresql'
        ? await adminQuery(serverId, 'select datname as name, pg_database_size(datname)::bigint as size from pg_database where datname = any($1)', [list.map(item => item.database)])
        : ['mysql', 'mariadb'].includes(engine)
          ? await adminQuery(serverId, 'select table_schema as name, sum(data_length + index_length) as size from information_schema.tables group by table_schema')
          : []
      const sizes = new Map(rows.map(row => [String(row.name), Number(row.size)]))
      for (const item of list) item.sizeBytes = sizes.get(item.database) ?? null
    } catch { /* size is informational only */ }
  }))
}

export async function getStorageDatabase(serviceId: string) {
  const databases = await listStorage()
  const database = databases.find(item => item.apps.some(app => app.serviceId === serviceId))
  if (!database) throw new ApiError('Database not found', 404)
  return { ...database, backups: await listBackupFiles(database), tableCount: await tableCount(database) }
}

async function tableCount(database: StorageDatabase) {
  if (database.serverRole === 'external' || database.engine !== 'postgresql') return null
  try {
    const rows = await adminQuery(database.serverId, `select count(*)::int as count from information_schema.tables where table_schema not in ('pg_catalog','information_schema')`, [], database.database)
    return Number(rows[0]?.count ?? 0)
  } catch { return null }
}

async function backupRoot() {
  const { getSetting } = await import('@/lib/settings')
  return getSetting('BACKUP_DIR')
}

export async function listBackupFiles(database: StorageDatabase) {
  const root = await backupRoot()
  const files: { file: string; serviceId: string; sizeBytes: number; createdAt: string }[] = []
  for (const app of database.apps) {
    const directory = path.join(root, 'data-services', app.serviceId)
    if (!existsSync(directory)) continue
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith('.dump')) continue
      const info = await stat(path.join(directory, entry))
      files.push({ file: entry, serviceId: app.serviceId, sizeBytes: info.size, createdAt: info.mtime.toISOString() })
    }
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Connection details with the password, for admins. The caller audits the reveal. */
export async function revealConnection(serviceId: string) {
  const { rows } = await query<{ database_name: string; username: string | null; password_ciphertext: string | null; provider: string; host: string; port: number; options: Record<string, unknown> }>(
    `select s.database_name,s.username,s.password_ciphertext,dc.provider,dc.host,dc.port,s.options from project_data_services s join data_connections dc on dc.id=s.connection_id where s.id=$1`, [serviceId])
  const row = rows[0]
  if (!row) throw new ApiError('Database not found', 404)
  const password = row.password_ciphertext ? decryptSecret(row.password_ciphertext) : ''
  const protocol = row.provider === 'postgresql' ? 'postgresql' : row.provider === 'sqlserver' ? 'sqlserver' : row.provider
  const auth = row.username ? `${encodeURIComponent(row.username)}${password ? `:${encodeURIComponent(password)}` : ''}@` : ''
  const suffix = row.options?.tls ? '?sslmode=require' : ''
  return { url: `${protocol}://${auth}${row.host}:${row.port}/${encodeURIComponent(row.database_name)}${suffix}`, password, username: row.username }
}

/**
 * Restores a backup into a brand-new database on the same server, so nothing that is
 * running is touched. Switch the app over to it once you have checked the data.
 */
export async function restoreToNewDatabase(serviceId: string, file: unknown) {
  if (typeof file !== 'string' || !/^[\w.-]+\.dump$/.test(file)) throw new ApiError('Choose a backup file', 400)
  const database = await getStorageDatabase(serviceId)
  if (database.engine !== 'postgresql') throw new ApiError('Restore is available for PostgreSQL databases', 409)
  if (database.serverRole === 'external') throw new ApiError('Synergy has no admin access to this server', 409)
  const backup = database.backups.find(item => item.file === file)
  if (!backup) throw new ApiError('Backup not found', 404)
  const filePath = path.join(await backupRoot(), 'data-services', backup.serviceId, file)
  const owner = database.apps.find(app => app.serviceId === backup.serviceId)?.username || database.apps[0].username
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const target = safeName(`${database.database.slice(0, 40)}_restore_${stamp}`, 63)
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
  await adminQuery(database.serverId, `create database ${quote(target)}${owner ? ` owner ${quote(owner)}` : ''}`)
  const connection = await getSecretConnection(database.serverId)
  const { getSetting } = await import('@/lib/settings')
  const binPath = await getSetting('PG_BIN_PATH')
  const configured = path.join(binPath, process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore')
  const { spawn } = await import('child_process')
  const args = ['-h', connection.host, '-p', String(connection.port), '-U', connection.username || 'postgres', '-d', target, '--no-owner', '--no-acl', ...(owner ? ['--role', owner] : []), filePath]
  const result = await new Promise<{ code: number; output: string }>(resolve => {
    const child = spawn(existsSync(configured) ? configured : 'pg_restore', args, { windowsHide: true, env: { ...process.env, PGPASSWORD: connectionPassword(connection) } })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, output: output + '\nRestore timed out' }) }, 60 * 60_000)
    child.stdout.on('data', data => { output += data.toString() })
    child.stderr.on('data', data => { output += data.toString() })
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, output: output + error.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output }) })
  })
  // pg_restore exits non-zero for warnings such as missing extensions; report them rather than hide them.
  return { database: target, warnings: result.code === 0 ? null : result.output.slice(-1500) }
}

export interface EngineStatus {
  id: string
  name: string
  engine: string
  host: string
  port: number
  role: 'system' | 'apps' | 'external'
  provisioning: boolean
  status: string
  version: string | null
  listen: string | null
  localOnly: boolean | null
  remoteRules: number | null
  ssl: boolean | null
  pendingRestart: boolean
  databaseCount: number | null
  sizeBytes: number | null
  linkedCount: number
  warnings: string[]
}

/** What each database server is, how it is exposed, and what lives on it. */
export async function listEngines() {
  const list = await connections()
  const linked = await query<{ connection_id: string; count: number }>('select connection_id, count(distinct database_name)::int as count from project_data_services group by connection_id')
  const linkedBy = new Map(linked.rows.map(row => [row.connection_id, row.count]))
  return Promise.all(list.map(async (connection): Promise<EngineStatus> => {
    const role = serverRole(connection)
    const status: EngineStatus = { id: connection.id, name: connection.name, engine: connection.provider, host: connection.host, port: connection.port, role, provisioning: connection.provisioning_enabled,
      status: connection.last_status, version: null, listen: null, localOnly: null, remoteRules: null, ssl: null, pendingRestart: false, databaseCount: null, sizeBytes: null,
      linkedCount: linkedBy.get(connection.id) || 0, warnings: [] }
    if (role === 'external') return status
    try {
      if (connection.provider === 'postgresql') {
        const settings = await adminQuery(connection.id, `select name, setting, pending_restart from pg_settings where name in ('server_version','listen_addresses','ssl')`) as { name: string; setting: string; pending_restart: boolean }[]
        const get = (name: string) => settings.find(item => item.name === name)
        status.version = `PostgreSQL ${get('server_version')?.setting || ''}`.trim()
        status.listen = get('listen_addresses')?.setting || null
        status.pendingRestart = !!get('listen_addresses')?.pending_restart
        status.localOnly = !!status.listen && status.listen.split(',').map(item => item.trim()).every(item => ['localhost', '127.0.0.1', '::1'].includes(item))
        status.ssl = get('ssl')?.setting === 'on'
        try {
          const rules = await adminQuery(connection.id, `select count(*)::int as count from pg_hba_file_rules where type like 'host%' and error is null and address is not null and address not in ('127.0.0.1','::1')`)
          status.remoteRules = Number(rules[0]?.count ?? 0)
        } catch { status.remoteRules = null }
        const dbs = await adminQuery(connection.id, `select count(*)::int as count, coalesce(sum(pg_database_size(datname)),0)::bigint as size from pg_database where not datistemplate and datname <> 'postgres'`)
        status.databaseCount = Number(dbs[0]?.count ?? 0); status.sizeBytes = Number(dbs[0]?.size ?? 0)
      } else if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
        const rows = await adminQuery(connection.id, `select @@version as server_version, @@bind_address as bind_address`)
        status.version = `${connection.provider === 'mariadb' ? 'MariaDB' : 'MySQL'} ${rows[0]?.server_version || ''}`.trim()
        status.listen = String(rows[0]?.bind_address ?? '') || null
        status.localOnly = !!status.listen && ['127.0.0.1', 'localhost', '::1'].includes(status.listen)
        // have_ssl was removed in newer MySQL; a configured certificate means TLS is available.
        try {
          const tls = await adminQuery(connection.id, `show variables where variable_name in ('have_ssl','ssl_cert')`) as { Variable_name: string; Value: string }[]
          status.ssl = tls.some(item => (item.Variable_name === 'have_ssl' && item.Value === 'YES') || (item.Variable_name === 'ssl_cert' && !!item.Value))
        } catch { status.ssl = null }
        const dbs = await adminQuery(connection.id, `select count(distinct table_schema) as count, coalesce(sum(data_length + index_length),0) as size from information_schema.tables where table_schema not in ('mysql','information_schema','performance_schema','sys')`)
        status.databaseCount = Number(dbs[0]?.count ?? 0); status.sizeBytes = Number(dbs[0]?.size ?? 0)
      }
    } catch (error) {
      status.warnings.push(`Could not inspect the server: ${(error as Error).message.slice(0, 160)}`)
    }
    if (role === 'system' && status.databaseCount && status.databaseCount > 1) status.warnings.push(`Also holds ${status.databaseCount - 1} app databases. Synergy's own data should be on a server of its own.`)
    if (status.localOnly === false && !status.pendingRestart) status.warnings.push('Listens on every network interface, not just this machine')
    if (status.remoteRules) status.warnings.push(`${status.remoteRules} rule(s) allow sign-ins from other machines`)
    return status
  }))
}

/**
 * Makes a PostgreSQL server accept connections from this machine only. The setting
 * applies after the server's next restart, which the admin schedules.
 */
export async function restrictToLocalhost(connectionId: string) {
  const connection = await getSecretConnection(connectionId)
  if (connection.provider !== 'postgresql') throw new ApiError('Available for PostgreSQL servers', 409)
  if (hostKey(connection.host) !== 'local') throw new ApiError('Only servers on this machine can be changed from here', 409)
  await adminQuery(connectionId, `alter system set listen_addresses = 'localhost'`)
  await adminQuery(connectionId, 'select pg_reload_conf()')
  return { pendingRestart: true }
}

/** Where to connect to browse a database, using its server's admin account. PostgreSQL only. */
export async function explorerTarget(serviceId: string) {
  const database = await getStorageDatabase(serviceId)
  if (database.engine !== 'postgresql') throw new ApiError('Browsing and SQL are available for PostgreSQL databases. Use the engine\'s own tool for others.', 409)
  const connection = await getSecretConnection(database.serverId)
  if (!connection.username) throw new ApiError('Synergy has no admin sign-in for this server, so it can\'t browse this database', 409)
  return { database: database.database, target: { host: connection.host, port: connection.port, user: connection.username, password: connectionPassword(connection), database: database.database, ssl: connection.tls_enabled } }
}
