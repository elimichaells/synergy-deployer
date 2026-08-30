import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { RowDataPacket } from 'mysql2'
import { ApiError } from '@/lib/api'
import { db, query } from '@/lib/db'
import { killProcessTree } from '@/lib/exec'
import { decryptSecret } from '@/lib/secret-crypto'
import type { DataProvider } from '@/lib/data-services'

export const RELATIONAL_MIGRATION_PROVIDERS = ['postgresql', 'mysql', 'mariadb', 'sqlserver'] as const
type RelationalProvider = typeof RELATIONAL_MIGRATION_PROVIDERS[number]
type MigrationStatus = 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'activated'

interface MigrationService {
  id: string
  project_id: string
  project_name: string
  name: string
  provider: DataProvider
  host: string
  port: number
  database_name: string
  username: string | null
  password_ciphertext: string | null
  tls_enabled: boolean
  env_prefix: string
}

interface MigrationTable {
  sourceSchema: string
  sourceTable: string
  sourceObject: string
  targetSchema: string
  targetTable: string
  targetObject: string
}

interface MySqlTableRow extends RowDataPacket { table_schema: string; table_name: string }
interface MySqlCountRow extends RowDataPacket { count: string | number }

export interface DataMigrationJob {
  id: string
  project_id: string
  project_name: string
  source_service_id: string
  source_service_name: string
  source_provider: RelationalProvider
  source_database: string
  target_service_id: string
  target_service_name: string
  target_provider: RelationalProvider
  target_database: string
  status: MigrationStatus
  preserve_schema: boolean
  replace_target: boolean
  table_map: MigrationTable[]
  validation: Array<{ table: string; target: string; sourceRows: string; targetRows: string; match: boolean }> | null
  log: string
  error: string | null
  started_at: string | null
  finished_at: string | null
  activated_at: string | null
  created_at: string
}

const activeJobs = ((globalThis as unknown as { __dataMigrationJobs?: Map<string, ChildProcess> }).__dataMigrationJobs ??= new Map<string, ChildProcess>())
let migrationSchemaPromise: Promise<void> | null = null

export function ensureDataMigrationSchema() {
  if (!migrationSchemaPromise) {
    migrationSchemaPromise = query(`
      create table if not exists data_migration_jobs (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects(id) on delete cascade,
        source_service_id uuid not null references project_data_services(id) on delete restrict,
        target_service_id uuid not null references project_data_services(id) on delete restrict,
        status text not null default 'queued' check (status in ('queued','running','validating','succeeded','failed','cancelled','interrupted','activated')),
        preserve_schema boolean not null default true,
        replace_target boolean not null default false,
        table_map jsonb not null default '[]'::jsonb,
        validation jsonb,
        log text not null default '',
        error text,
        started_at timestamptz,
        finished_at timestamptz,
        activated_at timestamptz,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (source_service_id <> target_service_id)
      );
      create index if not exists data_migration_jobs_project_idx on data_migration_jobs (project_id,created_at desc);
      create index if not exists data_migration_jobs_active_idx on data_migration_jobs (status) where status in ('queued','running','validating')
    `).then(() => undefined).catch((error) => {
      migrationSchemaPromise = null
      throw error
    })
  }
  return migrationSchemaPromise
}

function assertRelational(provider: DataProvider): asserts provider is RelationalProvider {
  if (!RELATIONAL_MIGRATION_PROVIDERS.includes(provider as RelationalProvider)) {
    throw new ApiError(`${provider} cannot participate in an automatic relational migration`, 400)
  }
}

async function migrationService(id: string) {
  const { rows } = await query<MigrationService>(
    `select pds.id,pds.project_id,p.name as project_name,pds.name,pds.database_name,pds.username,
            pds.password_ciphertext,pds.env_prefix,dc.provider,dc.host,dc.port,dc.tls_enabled
       from project_data_services pds join projects p on p.id=pds.project_id
       join data_connections dc on dc.id=pds.connection_id where pds.id=$1`,
    [id]
  )
  if (!rows[0]) throw new ApiError('Project data service not found', 404)
  assertRelational(rows[0].provider)
  if (!rows[0].username || !rows[0].password_ciphertext) throw new ApiError('The selected service has no migration credential', 409)
  return rows[0] as MigrationService & { provider: RelationalProvider }
}

function password(service: MigrationService) {
  return service.password_ciphertext ? decryptSecret(service.password_ciphertext) : ''
}

function defaultSchema(service: MigrationService) {
  if (service.provider === 'postgresql') return 'public'
  if (service.provider === 'sqlserver') return 'dbo'
  return service.database_name
}

function quoteIdentifier(provider: RelationalProvider, value: string) {
  if (provider === 'postgresql') return `"${value.replace(/"/g, '""')}"`
  if (provider === 'sqlserver') return `[${value.replace(/]/g, ']]')}]`
  return `\`${value.replace(/`/g, '``')}\``
}

async function listTables(service: MigrationService & { provider: RelationalProvider }) {
  if (service.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: service.host, port: service.port, database: service.database_name, user: service.username || undefined, password: password(service), ssl: service.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000 })
    await client.connect()
    try {
      const { rows } = await client.query<{ table_schema: string; table_name: string }>(`select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema') and table_schema not like 'pg_toast%' order by table_schema,table_name`)
      return rows.map((row) => ({ schema: row.table_schema, table: row.table_name }))
    } finally { await client.end() }
  }
  if (service.provider === 'mysql' || service.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: service.host, port: service.port, user: service.username || undefined, password: password(service), database: service.database_name, ssl: service.tls_enabled ? {} : undefined, connectTimeout: 10_000 })
    try {
      const [rows] = await client.query<MySqlTableRow[]>(`select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and table_schema=? order by table_name`, [service.database_name])
      return rows.map((row) => ({ schema: row.table_schema, table: row.table_name }))
    } finally { await client.end() }
  }
  const sql = await import('mssql')
  const pool = await new sql.ConnectionPool({ server: service.host, port: service.port, user: service.username || undefined, password: password(service), database: service.database_name, options: { encrypt: service.tls_enabled, trustServerCertificate: !service.tls_enabled }, connectionTimeout: 10_000 }).connect()
  try {
    const result = await pool.request().query<{ table_schema: string; table_name: string }>(`select schema_name(schema_id) as table_schema,name as table_name from sys.tables order by schema_name(schema_id),name`)
    return result.recordset.map((row) => ({ schema: row.table_schema, table: row.table_name }))
  } finally { await pool.close() }
}

function tableMap(source: MigrationService & { provider: RelationalProvider }, target: MigrationService & { provider: RelationalProvider }, tables: Array<{ schema: string; table: string }>) {
  const sourceDefault = defaultSchema(source)
  const targetDefault = defaultSchema(target)
  return tables.map<MigrationTable>((item) => {
    const targetTable = item.schema === sourceDefault ? item.table : `${item.schema}_${item.table}`
    return {
      sourceSchema: item.schema,
      sourceTable: item.table,
      sourceObject: `${item.schema}.${item.table}`,
      targetSchema: targetDefault,
      targetTable,
      targetObject: `${targetDefault}.${targetTable}`,
    }
  })
}

export async function previewDataMigration(sourceServiceId: string, targetServiceId: string) {
  await ensureDataMigrationSchema()
  if (!sourceServiceId || !targetServiceId || sourceServiceId === targetServiceId) throw new ApiError('Choose two different project data services', 400)
  const [source, target] = await Promise.all([migrationService(sourceServiceId), migrationService(targetServiceId)])
  if (source.project_id !== target.project_id) throw new ApiError('Source and target services must belong to the same project', 409)
  const [sourceTables, targetTables] = await Promise.all([listTables(source), listTables(target)])
  if (!sourceTables.length) throw new ApiError('The source database has no tables to migrate', 409)
  const mapped = tableMap(source, target, sourceTables)
  const existing = new Set(targetTables.map((item) => `${item.schema}.${item.table}`.toLowerCase()))
  return {
    source: { id: source.id, name: source.name, provider: source.provider, database: source.database_name, projectId: source.project_id, projectName: source.project_name },
    target: { id: target.id, name: target.name, provider: target.provider, database: target.database_name },
    tables: mapped.map((item) => ({ ...item, targetExists: existing.has(item.targetObject.toLowerCase()) })),
    existingTargetTables: mapped.filter((item) => existing.has(item.targetObject.toLowerCase())).length,
  }
}

export async function listDataMigrationJobs(projectId?: string) {
  await ensureDataMigrationSchema()
  const params = projectId ? [projectId] : []
  const where = projectId ? 'where dmj.project_id=$1' : ''
  const { rows } = await query<DataMigrationJob>(
    `select dmj.*,p.name as project_name,src.name as source_service_name,src.database_name as source_database,
            srcdc.provider as source_provider,tgt.name as target_service_name,tgt.database_name as target_database,
            tgtdc.provider as target_provider
       from data_migration_jobs dmj join projects p on p.id=dmj.project_id
       join project_data_services src on src.id=dmj.source_service_id join data_connections srcdc on srcdc.id=src.connection_id
       join project_data_services tgt on tgt.id=dmj.target_service_id join data_connections tgtdc on tgtdc.id=tgt.connection_id
       ${where} order by dmj.created_at desc limit 100`,
    params
  )
  return rows
}

function slingExecutable() {
  const configured = process.env.SLING_EXE || 'C:\\web\\tools\\sling\\sling.exe'
  if (!existsSync(configured)) throw new ApiError('Install the Sling migration engine from Settings before starting a migration', 409)
  return configured
}

function slingConnection(service: MigrationService & { provider: RelationalProvider }) {
  const common = { host: service.host, port: service.port, user: service.username, password: password(service), database: service.database_name }
  if (service.provider === 'postgresql') return JSON.stringify({ type: 'postgres', ...common, sslmode: service.tls_enabled ? 'require' : 'disable' })
  if (service.provider === 'sqlserver') return JSON.stringify({ type: 'sqlserver', ...common, encrypt: service.tls_enabled ? 'true' : 'false', trust_server_certificate: service.tls_enabled ? 'false' : 'true' })
  return JSON.stringify({ type: service.provider, ...common, tls: service.tls_enabled ? 'skip-verify' : 'false' })
}

async function appendJobLog(jobId: string, value: string, secrets: string[]) {
  let safe = value
  for (const secret of secrets.filter(Boolean)) {
    safe = safe.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]')
  }
  await query(`update data_migration_jobs set log=right(coalesce(log,'') || $1,1000000),updated_at=now() where id=$2`, [safe, jobId])
}

async function countTables(service: MigrationService & { provider: RelationalProvider }, tables: MigrationTable[], side: 'source' | 'target') {
  const results: Record<string, string> = {}
  if (service.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: service.host, port: service.port, database: service.database_name, user: service.username || undefined, password: password(service), ssl: service.tls_enabled ? { rejectUnauthorized: false } : false })
    await client.connect()
    try {
      for (const item of tables) {
        const schema = side === 'source' ? item.sourceSchema : item.targetSchema
        const table = side === 'source' ? item.sourceTable : item.targetTable
        const { rows } = await client.query<{ count: string }>(`select count(*)::text as count from ${quoteIdentifier(service.provider, schema)}.${quoteIdentifier(service.provider, table)}`)
        results[item.sourceObject] = rows[0].count
      }
    } finally { await client.end() }
    return results
  }
  if (service.provider === 'mysql' || service.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: service.host, port: service.port, user: service.username || undefined, password: password(service), database: service.database_name, ssl: service.tls_enabled ? {} : undefined })
    try {
      for (const item of tables) {
        const table = side === 'source' ? item.sourceTable : item.targetTable
        const [rows] = await client.query<MySqlCountRow[]>(`select count(*) as count from ${quoteIdentifier(service.provider, table)}`)
        results[item.sourceObject] = String(rows[0].count)
      }
    } finally { await client.end() }
    return results
  }
  const sql = await import('mssql')
  const pool = await new sql.ConnectionPool({ server: service.host, port: service.port, user: service.username || undefined, password: password(service), database: service.database_name, options: { encrypt: service.tls_enabled, trustServerCertificate: !service.tls_enabled } }).connect()
  try {
    for (const item of tables) {
      const schema = side === 'source' ? item.sourceSchema : item.targetSchema
      const table = side === 'source' ? item.sourceTable : item.targetTable
      const result = await pool.request().query<{ count: string | number }>(`select count_big(*) as count from ${quoteIdentifier(service.provider, schema)}.${quoteIdentifier(service.provider, table)}`)
      results[item.sourceObject] = String(result.recordset[0].count)
    }
  } finally { await pool.close() }
  return results
}

async function executeMigrationJob(jobId: string) {
  const { rows } = await query<{ source_service_id: string; target_service_id: string; preserve_schema: boolean; table_map: MigrationTable[] }>('select source_service_id,target_service_id,preserve_schema,table_map from data_migration_jobs where id=$1', [jobId])
  if (!rows[0]) return
  const [source, target] = await Promise.all([migrationService(rows[0].source_service_id), migrationService(rows[0].target_service_id)])
  const tables = rows[0].table_map
  const jobRoot = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Manager', 'migrations', jobId)
  const configPath = path.join(jobRoot, 'replication.json')
  const sourceSecret = password(source)
  const targetSecret = password(target)
  try {
    const claimed = await query(`update data_migration_jobs set status='running',started_at=now(),error=null,log='',updated_at=now() where id=$1 and status='queued' returning id`, [jobId])
    if (!claimed.rowCount) return
    await mkdir(jobRoot, { recursive: true })
    const streams = Object.fromEntries(tables.map((item) => [item.sourceObject, { object: item.targetObject }]))
    await writeFile(configPath, JSON.stringify({ source: 'MANAGER_MIGRATION_SOURCE', target: 'MANAGER_MIGRATION_TARGET', defaults: { mode: 'full-refresh', target_options: { column_casing: 'source' } }, streams }, null, 2), 'utf8')
    await appendJobLog(jobId, `[migration] ${source.provider} ${source.database_name} -> ${target.provider} ${target.database_name}\n[migration] ${tables.length} table(s), schema preservation ${rows[0].preserve_schema ? 'enabled' : 'disabled'}\n`, [])

    const currentBeforeSpawn = await query<{ status: MigrationStatus }>('select status from data_migration_jobs where id=$1', [jobId])
    if (currentBeforeSpawn.rows[0]?.status !== 'running') return

    const child = spawn(slingExecutable(), ['run', '-r', configPath], {
      cwd: jobRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        MANAGER_MIGRATION_SOURCE: slingConnection(source),
        MANAGER_MIGRATION_TARGET: slingConnection(target),
        SLING_SCHEMA_MIGRATION: rows[0].preserve_schema ? 'all' : '',
        SLING_SEND_TELEMETRY: 'false',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
    })
    activeJobs.set(jobId, child)
    child.stdout?.on('data', (data) => void appendJobLog(jobId, data.toString(), [sourceSecret, targetSecret]))
    child.stderr?.on('data', (data) => void appendJobLog(jobId, data.toString(), [sourceSecret, targetSecret]))
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
    activeJobs.delete(jobId)
    const current = await query<{ status: MigrationStatus }>('select status from data_migration_jobs where id=$1', [jobId])
    if (current.rows[0]?.status === 'cancelled') return
    if (exitCode !== 0) throw new Error(`Sling exited with code ${exitCode}`)

    await query(`update data_migration_jobs set status='validating',updated_at=now() where id=$1`, [jobId])
    await appendJobLog(jobId, '\n[validation] Comparing exact source and target row counts...\n', [])
    const [sourceCounts, targetCounts] = await Promise.all([countTables(source, tables, 'source'), countTables(target, tables, 'target')])
    const currentAfterValidation = await query<{ status: MigrationStatus }>('select status from data_migration_jobs where id=$1', [jobId])
    if (currentAfterValidation.rows[0]?.status !== 'validating') return
    const validation = tables.map((item) => ({ table: item.sourceObject, target: item.targetObject, sourceRows: sourceCounts[item.sourceObject], targetRows: targetCounts[item.sourceObject], match: sourceCounts[item.sourceObject] === targetCounts[item.sourceObject] }))
    const mismatches = validation.filter((item) => !item.match)
    if (mismatches.length) {
      await query(`update data_migration_jobs set status='failed',validation=$1,error=$2,finished_at=now(),updated_at=now() where id=$3 and status='validating'`, [JSON.stringify(validation), `${mismatches.length} table(s) failed row-count validation`, jobId])
      await appendJobLog(jobId, `[validation] FAILED: ${mismatches.length} table(s) differ.\n`, [])
      return
    }
    await query(`update data_migration_jobs set status='succeeded',validation=$1,finished_at=now(),updated_at=now() where id=$2 and status='validating'`, [JSON.stringify(validation), jobId])
    await appendJobLog(jobId, `[validation] PASS: ${validation.length} table(s) match exactly.\n`, [])
  } catch (error) {
    activeJobs.delete(jobId)
    const message = error instanceof Error ? error.message : 'Database migration failed'
    const current = await query<{ status: MigrationStatus }>('select status from data_migration_jobs where id=$1', [jobId])
    if (current.rows[0]?.status !== 'cancelled') {
      await query(`update data_migration_jobs set status='failed',error=$1,finished_at=now(),updated_at=now() where id=$2`, [message.slice(0, 2000), jobId])
      await appendJobLog(jobId, `\n[failed] ${message}\n`, [sourceSecret, targetSecret])
    }
  } finally {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function startDataMigration(input: Record<string, unknown>, createdBy?: string | null) {
  const sourceServiceId = String(input.sourceServiceId || '')
  const targetServiceId = String(input.targetServiceId || '')
  const preview = await previewDataMigration(sourceServiceId, targetServiceId)
  const requestedTables = Array.isArray(input.tables) ? input.tables.map(String) : []
  const selected = requestedTables.length ? preview.tables.filter((item) => requestedTables.includes(item.sourceObject)) : preview.tables
  if (!selected.length) throw new ApiError('Select at least one source table', 400)
  const replaceTarget = input.replaceTarget === true
  if (!replaceTarget && selected.some((item) => item.targetExists)) throw new ApiError('Target tables already exist. Confirm replacement or choose an empty target service.', 409)
  slingExecutable()
  const client = await db.connect()
  let jobId = ''
  try {
    await client.query('begin')
    const serviceLocks = [sourceServiceId, targetServiceId].sort()
    await client.query('select pg_advisory_xact_lock(hashtext($1)),pg_advisory_xact_lock(hashtext($2))', serviceLocks)
    const active = await client.query<{ id: string }>(`select id from data_migration_jobs where status in ('queued','running','validating') and (source_service_id in ($1,$2) or target_service_id in ($1,$2)) limit 1`, [sourceServiceId, targetServiceId])
    if (active.rows[0]) throw new ApiError('One of these services already has an active migration', 409)
    const { rows } = await client.query<{ id: string }>(
      `insert into data_migration_jobs (project_id,source_service_id,target_service_id,preserve_schema,replace_target,table_map,created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [preview.source.projectId, sourceServiceId, targetServiceId, input.preserveSchema !== false, replaceTarget, JSON.stringify(selected.map(({ targetExists: _, ...item }) => item)), createdBy || null]
    )
    jobId = rows[0].id
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
  setImmediate(() => void executeMigrationJob(jobId))
  return (await listDataMigrationJobs(preview.source.projectId)).find((job) => job.id === jobId)
}

export async function cancelDataMigration(id: string) {
  await ensureDataMigrationSchema()
  const result = await query(`update data_migration_jobs set status='cancelled',error='Cancelled by administrator',finished_at=now(),updated_at=now() where id=$1 and status in ('queued','running','validating')`, [id])
  if (!result.rowCount) throw new ApiError('Migration is not active', 409)
  const child = activeJobs.get(id)
  if (child?.pid) killProcessTree(child.pid)
  activeJobs.delete(id)
}

export async function activateDataMigration(id: string) {
  await ensureDataMigrationSchema()
  const client = await db.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query<{ source_service_id: string; target_service_id: string; status: MigrationStatus; project_id: string }>('select source_service_id,target_service_id,status,project_id from data_migration_jobs where id=$1 for update', [id])
    const job = rows[0]
    if (!job) throw new ApiError('Migration not found', 404)
    if (job.status !== 'succeeded') throw new ApiError('Only a successfully validated migration can be activated', 409)
    const services = await client.query<{ id: string; name: string; env_prefix: string }>('select id,name,env_prefix from project_data_services where id in ($1,$2) for update', [job.source_service_id, job.target_service_id])
    const source = services.rows.find((item) => item.id === job.source_service_id)
    const target = services.rows.find((item) => item.id === job.target_service_id)
    if (!source || !target) throw new ApiError('Migration services no longer exist', 409)
    const suffix = Date.now().toString(36).toUpperCase()
    await client.query('update project_data_services set name=$1,env_prefix=$2,updated_at=now() where id=$3', [`legacy_${suffix.toLowerCase()}`, `LEGACY_${suffix}`, source.id])
    await client.query('update project_data_services set name=$1,env_prefix=$2,updated_at=now() where id=$3', [source.name, source.env_prefix, target.id])
    await client.query(`update data_migration_jobs set status='activated',activated_at=now(),updated_at=now() where id=$1`, [id])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
}

export async function recoverInterruptedDataMigrations() {
  await ensureDataMigrationSchema()
  await query(`update data_migration_jobs set status='interrupted',error='Manager restarted during migration',finished_at=now(),updated_at=now() where status in ('queued','running','validating')`)
}
