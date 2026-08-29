import { Pool, type FieldDef } from 'pg'
import { query } from '@/lib/db'

/**
 * Admin access to every database on the Postgres server the manager uses.
 * Pools are created lazily per database and cached across route bundles.
 */

const QUERY_TIMEOUT_MS = 20_000
export const MAX_RESULT_ROWS = 1_000

const pools: Map<string, Pool> =
  ((globalThis as unknown as { __dbAdminPools?: Map<string, Pool> }).__dbAdminPools ??= new Map())

export function connectionConfig(database: string) {
  const url = process.env.DATABASE_URL
  if (url) {
    const parsed = new URL(url)
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || '5432', 10),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
    }
  }
  return {
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database,
  }
}

function getPool(database: string): Pool {
  let pool = pools.get(database)
  if (!pool) {
    pool = new Pool({
      ...connectionConfig(database),
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: QUERY_TIMEOUT_MS,
    })
    pools.set(database, pool)
  }
  return pool
}

/** Quote a SQL identifier (table/schema/column name) */
function quoteIdent(name: string) {
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a SQL string literal (for statements that cannot take parameters) */
function quoteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

const IDENT_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_$]*$/

export function validateIdentifier(name: string, kind: string): string | null {
  if (!name) return `${kind} is required`
  if (name.length > 63) return `${kind} must be 63 characters or fewer`
  if (!IDENT_PATTERN.test(name)) {
    return `${kind} may only contain letters, digits, underscores and $ (and must not start with a digit)`
  }
  return null
}

/** Databases the manager must never drop */
export const PROTECTED_DATABASES = ['postgres', process.env.DATABASE_NAME || 'server_manager']

export interface DatabaseInfo {
  name: string
  size_bytes: number
  size_pretty: string
  connections: number
}

export async function listDatabases(): Promise<DatabaseInfo[]> {
  const { rows } = await query<DatabaseInfo>(
    `select d.datname as name,
            pg_database_size(d.datname)::bigint as size_bytes,
            pg_size_pretty(pg_database_size(d.datname)) as size_pretty,
            coalesce(s.connections, 0)::int as connections
     from pg_database d
     left join (
       select datname, count(*) as connections
       from pg_stat_activity
       group by datname
     ) s on s.datname = d.datname
     where d.datistemplate = false
     order by d.datname`
  )
  return rows
}

/** Throws if the database does not exist on the server (also blocks name injection) */
export async function assertDatabase(database: string) {
  const { rows } = await query(
    'select 1 from pg_database where datname = $1 and datistemplate = false',
    [database]
  )
  if (rows.length === 0) {
    throw new Error(`Database "${database}" not found`)
  }
}

export interface TableInfo {
  schema: string
  name: string
  est_rows: number
  size_bytes: number
  size_pretty: string
}

export async function listTables(database: string): Promise<TableInfo[]> {
  await assertDatabase(database)
  const pool = getPool(database)
  const { rows } = await pool.query<TableInfo>(
    `select n.nspname as schema,
            c.relname as name,
            greatest(c.reltuples, 0)::bigint as est_rows,
            pg_total_relation_size(c.oid)::bigint as size_bytes,
            pg_size_pretty(pg_total_relation_size(c.oid)) as size_pretty
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'information_schema')
     order by n.nspname, c.relname`
  )
  return rows
}

export interface TableRowsResult {
  columns: { name: string; type: string }[]
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}

const TYPE_NAMES: Record<number, string> = {
  16: 'bool', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json',
  700: 'float4', 701: 'float8', 1043: 'varchar', 1082: 'date', 1114: 'timestamp',
  1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb',
}

function mapColumns(fields: FieldDef[]) {
  return fields.map((f) => ({ name: f.name, type: TYPE_NAMES[f.dataTypeID] || String(f.dataTypeID) }))
}

export async function getTableRows(
  database: string,
  schema: string,
  table: string,
  page = 1,
  pageSize = 50
): Promise<TableRowsResult> {
  await assertDatabase(database)
  const pool = getPool(database)

  // Validate the table exists before interpolating identifiers
  const check = await pool.query(
    `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p')`,
    [schema, table]
  )
  if (check.rows.length === 0) {
    throw new Error(`Table "${schema}"."${table}" not found`)
  }

  const ident = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const safePageSize = Math.min(Math.max(pageSize, 1), 200)
  const safePage = Math.max(page, 1)
  const offset = (safePage - 1) * safePageSize

  const [countResult, dataResult] = await Promise.all([
    pool.query<{ count: string }>(`select count(*)::bigint as count from ${ident}`),
    pool.query(`select * from ${ident} limit ${safePageSize} offset ${offset}`),
  ])

  return {
    columns: mapColumns(dataResult.fields),
    rows: dataResult.rows,
    total: parseInt(countResult.rows[0].count, 10),
    page: safePage,
    pageSize: safePageSize,
  }
}

export interface SqlResult {
  command: string
  rowCount: number
  columns: { name: string; type: string }[]
  rows: Record<string, unknown>[]
  truncated: boolean
  durationMs: number
}

export interface CreateDatabaseResult {
  database: string
  owner?: { username: string; password: string }
}

/**
 * Create a database, optionally with a dedicated login role as its owner.
 * CREATE DATABASE / CREATE ROLE cannot take bind parameters, so identifiers
 * are strictly validated and the password is escaped as a literal.
 */
export async function createDatabase(
  name: string,
  options: { withOwner?: boolean; ownerName?: string } = {}
): Promise<CreateDatabaseResult> {
  const nameError = validateIdentifier(name, 'Database name')
  if (nameError) throw new Error(nameError)

  const { rows: existing } = await query('select 1 from pg_database where datname = $1', [name])
  if (existing.length > 0) throw new Error(`Database "${name}" already exists`)

  if (!options.withOwner) {
    await query(`create database ${quoteIdent(name)}`)
    return { database: name }
  }

  const username = options.ownerName || `${name}_user`
  const userError = validateIdentifier(username, 'Username')
  if (userError) throw new Error(userError)

  const { randomBytes } = await import('crypto')
  const password = randomBytes(16).toString('base64url')

  const { rows: existingRole } = await query('select 1 from pg_roles where rolname = $1', [username])
  if (existingRole.length === 0) {
    await query(`create role ${quoteIdent(username)} login password ${quoteLiteral(password)}`)
  } else {
    // Role exists — rotate its password so we can hand out working credentials
    await query(`alter role ${quoteIdent(username)} with login password ${quoteLiteral(password)}`)
  }

  try {
    await query(`create database ${quoteIdent(name)} owner ${quoteIdent(username)}`)
  } catch (err) {
    // Clean up a role we just created if the database failed
    if (existingRole.length === 0) {
      await query(`drop role if exists ${quoteIdent(username)}`).catch(() => undefined)
    }
    throw err
  }

  return { database: name, owner: { username, password } }
}

export async function rotateDatabaseRolePassword(roleName: string) {
  const roleError = validateIdentifier(roleName, 'Database role')
  if (roleError) throw new Error(roleError)
  const { rows } = await query('select 1 from pg_roles where rolname=$1 and rolcanlogin=true', [roleName])
  if (!rows[0]) throw new Error(`Database role "${roleName}" not found`)
  const { randomBytes } = await import('crypto')
  const password = randomBytes(24).toString('base64url')
  await query(`alter role ${quoteIdent(roleName)} with login password ${quoteLiteral(password)}`)
  return password
}

/** Drop a database after terminating its active connections. Protected databases are refused. */
export async function dropDatabase(name: string) {
  const nameError = validateIdentifier(name, 'Database name')
  if (nameError) throw new Error(nameError)
  if (PROTECTED_DATABASES.includes(name)) {
    throw new Error(`"${name}" is protected and cannot be dropped from the manager`)
  }
  await assertDatabase(name)
  const { rows: linkedProjects } = await query<{ project_name: string; environment: string }>(
    `select p.name as project_name,p.environment
       from project_databases pd join projects p on p.id=pd.project_id
      where pd.database_name=$1`,
    [name]
  )
  if (linkedProjects[0]) {
    throw new Error(`Database "${name}" belongs to ${linkedProjects[0].project_name} (${linkedProjects[0].environment}) and cannot be dropped directly`)
  }

  // Close and forget our own pool for this database first
  const pool = pools.get(name)
  if (pool) {
    pools.delete(name)
    await pool.end().catch(() => undefined)
  }

  await query(
    'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
    [name]
  )
  await query(`drop database ${quoteIdent(name)}`)
}

/**
 * Run arbitrary SQL against a database. When readOnly is true the statement
 * runs inside a READ ONLY transaction, so any write attempt errors out.
 */
export async function runSql(database: string, sql: string, readOnly: boolean): Promise<SqlResult> {
  await assertDatabase(database)
  const pool = getPool(database)
  const client = await pool.connect()
  const started = Date.now()

  try {
    let result
    if (readOnly) {
      await client.query('begin transaction read only')
      try {
        result = await client.query(sql)
        await client.query('commit')
      } catch (err) {
        await client.query('rollback').catch(() => undefined)
        throw err
      }
    } else {
      result = await client.query(sql)
    }

    // Multi-statement strings return an array of results — report the last one
    const last = Array.isArray(result) ? result[result.length - 1] : result
    const rows = (last.rows || []).slice(0, MAX_RESULT_ROWS)

    return {
      command: last.command || 'OK',
      rowCount: last.rowCount ?? rows.length,
      columns: last.fields ? mapColumns(last.fields) : [],
      rows: rows as Record<string, unknown>[],
      truncated: (last.rows?.length || 0) > MAX_RESULT_ROWS,
      durationMs: Date.now() - started,
    }
  } finally {
    client.release()
  }
}
