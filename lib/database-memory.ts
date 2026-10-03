import path from 'path'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { audit } from '@/lib/audit'
import { ApiError } from '@/lib/api'
import { connectionPassword, getSecretConnection, listDataConnections } from '@/lib/data-services'
import { currentMemorySnapshot, type DatabaseUsage } from '@/lib/server-memory'
import { idleConnectionNotes, mysqlRecommendations, tuningSettings, type ConnectionGroup, type MysqlFacts, type Recommendation } from '@/lib/database-tuning-policy'

/**
 * What each database server on this machine uses, who is connected to it, and memory settings
 * worth changing. Read with the manager's saved admin connection for each server.
 */

export interface DatabaseServerReport {
  connectionId: string
  name: string
  engine: string
  port: number
  version: string | null
  /** Memory of the server's whole process tree, if its Windows service was found. */
  memoryMb: number | null
  service: string | null
  dataMb: number | null
  databases: number | null
  connections: { total: number; idle: number; groups: ConnectionGroup[] } | null
  apps: string[]
  recommendations: Recommendation[]
  notes: string[]
  error: string | null
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const TIMEOUT_MS = 8000

async function inspectPostgres(connectionId: string) {
  const connection = await getSecretConnection(connectionId)
  const { Client } = await import('pg')
  const client = new Client({ host: connection.host, port: connection.port, user: connection.username || undefined, password: connectionPassword(connection),
    database: String(connection.options?.database || 'postgres'), connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: 15000, ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false })
  await client.connect()
  try {
    const version = (await client.query<{ v: string }>("select current_setting('server_version') as v")).rows[0]?.v ?? null
    const size = (await client.query<{ n: number; bytes: string }>('select count(*)::int as n, coalesce(sum(pg_database_size(datname)),0)::text as bytes from pg_database where not datistemplate')).rows[0]
    const groups = (await client.query<{ login: string; database: string; state: string; count: number }>(
      `select coalesce(usename,'-') as login, coalesce(datname,'-') as database, coalesce(state,'background') as state, count(*)::int as count
       from pg_stat_activity where backend_type = 'client backend' group by 1,2,3 order by count desc`)).rows
    return { version, dataMb: Math.round(Number(size.bytes) / 1048576), databases: size.n, groups, recommendations: [] as Recommendation[] }
  } finally { await client.end().catch(() => undefined) }
}

async function readMysqlFacts(connectionId: string) {
  const connection = await getSecretConnection(connectionId)
  const mysql = await import('mysql2/promise')
  const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.username || undefined, password: connectionPassword(connection), connectTimeout: TIMEOUT_MS })
  try {
    const rows = async <T>(sql: string) => (await client.query(sql))[0] as T[]
    const pairsOf = (list: { Variable_name: string; Value: string }[]) => Object.fromEntries(list.map(row => [row.Variable_name.toLowerCase(), String(row.Value)]))
    const variables = pairsOf(await rows("show global variables where Variable_name in ('version','version_comment','performance_schema','innodb_log_buffer_size','innodb_buffer_pool_size')"))
    const status = pairsOf(await rows("show global status where Variable_name in ('Mysqlx_connections_accepted','Threads_connected')"))
    const engine: 'mysql' | 'mariadb' = /mariadb/i.test(`${variables.version} ${variables.version_comment}`) ? 'mariadb' : 'mysql'
    let performanceSchemaMb: number | null = null
    if ((variables.performance_schema || '').toUpperCase() === 'ON') {
      try {
        const [row] = await rows<{ b: string | null }>("select sum(CURRENT_NUMBER_OF_BYTES_USED) as b from performance_schema.memory_summary_global_by_event_name where event_name like 'memory/performance_schema/%'")
        if (row?.b) performanceSchemaMb = Math.round(Number(row.b) / 1048576)
      } catch { /* Older servers do not report this; a typical figure is used instead. */ }
    }
    const plugins = await rows<{ status: string }>("select plugin_status as status from information_schema.plugins where plugin_name = 'mysqlx'")
    const size = (await rows<{ b: string | null; n: number }>("select coalesce(sum(data_length+index_length),0) as b, count(distinct table_schema) as n from information_schema.tables where table_schema not in ('mysql','sys','performance_schema','information_schema')"))[0]
    const groups = (await rows<{ login: string; database: string | null; command: string; count: number }>(
      "select user as login, db as `database`, command, count(*) as count from information_schema.processlist where user <> 'event_scheduler' group by user, db, command"))
      .map(row => ({ login: row.login, database: row.database || '-', state: row.command === 'Sleep' ? 'idle' : 'active', count: Number(row.count) }))
    const facts: MysqlFacts = { engine, variables, status, performanceSchemaMb, xPluginActive: plugins[0]?.status === 'ACTIVE' }
    return { facts, version: variables.version ?? null, dataMb: Math.round(Number(size?.b || 0) / 1048576), databases: Number(size?.n || 0), groups }
  } finally { await client.end().catch(() => undefined) }
}

const withTimeout = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The server did not answer in time')), TIMEOUT_MS * 2))])

export async function inspectDatabaseServers(): Promise<DatabaseServerReport[]> {
  const snapshot = await currentMemorySnapshot(60_000)
  const connections = (await listDataConnections()).filter(item => LOCAL_HOSTS.has(String(item.host).toLowerCase()) && ['postgresql', 'mysql', 'mariadb'].includes(item.provider))
  const { rows: links } = await query<{ connection_id: string; name: string }>(
    'select pds.connection_id, p.name from project_data_services pds join projects p on p.id = pds.project_id order by p.name')
  const reports: DatabaseServerReport[] = []
  for (const connection of connections) {
    const usage: DatabaseUsage | undefined = snapshot.databases.find(item => item.ports.includes(Number(connection.port)))
    const report: DatabaseServerReport = {
      connectionId: connection.id, name: connection.name, engine: connection.provider, port: Number(connection.port), version: null,
      memoryMb: usage?.privateMb ?? null, service: usage?.service ?? null, dataMb: null, databases: null, connections: null,
      apps: [...new Set(links.filter(link => link.connection_id === connection.id).map(link => link.name))], recommendations: [], notes: [], error: null,
    }
    try {
      if (connection.provider === 'postgresql') {
        const result = await withTimeout(inspectPostgres(connection.id))
        Object.assign(report, { version: result.version, dataMb: result.dataMb, databases: result.databases, connections: summarize(result.groups) })
      } else {
        const result = await withTimeout(readMysqlFacts(connection.id))
        Object.assign(report, { version: result.version, dataMb: result.dataMb, databases: result.databases, connections: summarize(result.groups) })
        report.recommendations = mysqlRecommendations(result.facts)
      }
      report.notes = idleConnectionNotes(report.connections?.groups ?? [])
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error)
    }
    reports.push(report)
  }
  return reports.sort((a, b) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0))
}

function summarize(groups: ConnectionGroup[]) {
  return { total: groups.reduce((sum, group) => sum + group.count, 0), idle: groups.filter(group => group.state === 'idle').reduce((sum, group) => sum + group.count, 0), groups }
}

/**
 * Applies chosen memory recommendations to a local MySQL or MariaDB server and restarts it. The
 * script checks the new settings first and restores the old ones if the server does not come back.
 */
export async function tuneDatabaseServer(connectionId: string, keys: unknown, userId: string | null | undefined) {
  const report = (await inspectDatabaseServers()).find(item => item.connectionId === connectionId)
  if (!report) throw new ApiError('Database server not found on this machine', 404)
  if (report.engine !== 'mysql' && report.engine !== 'mariadb') throw new ApiError('Only MySQL and MariaDB settings can be tuned here', 400)
  if (!report.service) throw new ApiError('The Windows service for this server was not found', 409)
  if (report.error) throw new ApiError(`The server could not be inspected: ${report.error}`, 409)
  let settings: string
  try { settings = tuningSettings(report.recommendations, keys) } catch (error) { throw new ApiError((error as Error).message, 400) }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(report.service)) throw new ApiError('Unsupported service name', 400)

  const before = report.memoryMb
  const script = path.join(process.cwd(), 'scripts', 'tune-database-memory.ps1')
  const result = await runCommand({ file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Engine', report.engine, '-ServiceName', report.service, '-Settings', settings] }, undefined, 300_000, undefined, undefined, true)
  const log = result.output.split(/\r?\n/).filter(line => line.startsWith('[tune]') || /rejected|did not|restored|failed|error/i.test(line)).slice(-12)
  const ok = result.code === 0 && /RESULT \{"/.test(result.output)
  await audit(userId, 'database.memory_tuned', `connection:${connectionId}`, { service: report.service, settings, ok, before })
  // Give the restarted server a moment, then measure again.
  let after: number | null = null
  if (ok) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    after = (await currentMemorySnapshot(0)).databases.find(item => item.service === report.service)?.privateMb ?? null
  }
  return { ok, settings, before, after, log, apps: report.apps }
}
