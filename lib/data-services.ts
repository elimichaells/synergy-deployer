import { randomBytes } from 'crypto'
import { ApiError } from '@/lib/api'
import { db, query } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'
import { dataServiceRemovalReason, type DataServiceRemovalFacts } from '@/lib/data-removal-policy'
import { acquireProjectOperation } from '@/lib/project-operation'

export const DATA_PROVIDERS = ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'redis'] as const
export type DataProvider = typeof DATA_PROVIDERS[number]
export const DATA_CONNECTION_PURPOSES = ['shared_application', 'dedicated_application', 'external_service'] as const
export type DataConnectionPurpose = typeof DATA_CONNECTION_PURPOSES[number]

export const DATA_PROVIDER_DEFAULT_PORTS: Record<DataProvider, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  mongodb: 27017,
  redis: 6379,
}

export interface DataConnection {
  id: string
  name: string
  provider: DataProvider
  host: string
  port: number
  username: string | null
  tls_enabled: boolean
  options: Record<string, unknown>
  purpose: DataConnectionPurpose
  managed: boolean
  is_default: boolean
  provisioning_enabled: boolean
  last_status: 'untested' | 'healthy' | 'failed'
  last_error: string | null
  last_tested_at: string | null
  service_count: number
  created_at: string
  updated_at: string
}

export interface ProjectDataService {
  id: string
  project_id: string
  project_name: string
  environment: 'production' | 'staging'
  connection_id: string
  connection_name: string
  provider: DataProvider
  host: string
  port: number
  tls_enabled: boolean
  name: string
  database_name: string
  username: string | null
  env_prefix: string
  application_primary: boolean
  removal_blocked_reason: string | null
  options: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface SecretConnection extends DataConnection {
  password_ciphertext: string | null
}

let schemaPromise: Promise<void> | null = null

export function ensureDataServicesSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      create table if not exists data_connections (
        id uuid primary key default gen_random_uuid(),
        name text unique not null,
        provider text not null check (provider in ('postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'redis')),
        host text not null,
        port integer not null check (port between 1 and 65535),
        username text,
        password_ciphertext text,
        tls_enabled boolean not null default false,
        options jsonb not null default '{}'::jsonb,
        last_status text not null default 'untested',
        last_error text,
        last_tested_at timestamptz,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      alter table data_connections add column if not exists purpose text not null default 'shared_application';
      alter table data_connections add column if not exists managed boolean not null default false;
      alter table data_connections add column if not exists is_default boolean not null default false;
      alter table data_connections add column if not exists provisioning_enabled boolean not null default true;
      create table if not exists project_data_services (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects(id) on delete cascade,
        connection_id uuid not null references data_connections(id) on delete restrict,
        name text not null,
        database_name text not null,
        username text,
        password_ciphertext text,
        env_prefix text not null,
        options jsonb not null default '{}'::jsonb,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (project_id, name),
        unique (project_id, env_prefix)
      );
      alter table project_data_services add column if not exists application_primary boolean not null default false;
      create unique index if not exists project_data_services_one_application_primary_idx
        on project_data_services (project_id) where application_primary;
      create table if not exists data_service_backup_schedules (
        id uuid primary key default gen_random_uuid(),
        service_id uuid unique not null references project_data_services(id) on delete cascade,
        frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
        time_of_day text not null default '03:00',
        timezone text not null default 'UTC',
        day_of_week integer not null default 0 check (day_of_week between 0 and 6),
        day_of_month integer not null default 1 check (day_of_month between 1 and 28),
        month_of_year integer not null default 1 check (month_of_year between 1 and 12),
        retention_count integer not null default 30 check (retention_count between 1 and 365),
        enabled boolean not null default true,
        next_run_at timestamptz,
        last_started_at timestamptz,
        last_finished_at timestamptz,
        last_status text not null default 'idle',
        last_file text,
        last_error text,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists project_data_services_project_idx on project_data_services (project_id);
      create index if not exists project_data_services_connection_idx on project_data_services (connection_id);
      create unique index if not exists data_connections_default_provider_idx on data_connections (provider) where is_default = true
    `).then(() => undefined).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

function assertProvider(value: unknown): asserts value is DataProvider {
  if (!DATA_PROVIDERS.includes(value as DataProvider)) throw new ApiError('Unsupported database provider', 400)
}

function assertPurpose(value: unknown): asserts value is DataConnectionPurpose {
  if (!DATA_CONNECTION_PURPOSES.includes(value as DataConnectionPurpose)) throw new ApiError('Unsupported connection purpose', 400)
}

function normalizedHost(value: string) {
  const host = value.trim().toLowerCase()
  return ['localhost', '::1', '[::1]'].includes(host) ? '127.0.0.1' : host
}

function assertNotControlPlane(provider: DataProvider, host: string, port: number) {
  if (provider !== 'postgresql') return
  const controlHost = normalizedHost(process.env.DATABASE_HOST || '127.0.0.1')
  const controlPort = Number(process.env.DATABASE_PORT || 5432)
  if (normalizedHost(host) === controlHost && port === controlPort) {
    throw new ApiError('Manager control PostgreSQL is reserved. Register a separate application PostgreSQL provider.', 409)
  }
}

function requiredText(value: unknown, label: string) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new ApiError(`${label} is required`, 400)
  return text
}

function safeName(value: string, max = 63) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) throw new ApiError('Name must contain letters or numbers', 400)
  return (/^[a-z_]/.test(normalized) ? normalized : `app_${normalized}`).slice(0, max)
}

function envPrefix(value: string) {
  const prefix = value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!prefix) throw new ApiError('Environment prefix is required', 400)
  return prefix.slice(0, 40)
}

function newPassword() {
  return randomBytes(30).toString('base64url')
}

function quotePg(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function quoteSqlServer(value: string) {
  return `[${value.replace(/]/g, ']]')}]`
}

function sqlLiteral(value: string) {
  return value.replace(/'/g, "''")
}

async function getSecretConnection(id: string): Promise<SecretConnection> {
  await ensureDataServicesSchema()
  const { rows } = await query<SecretConnection>(
    `select dc.*, count(pds.id)::int as service_count
       from data_connections dc left join project_data_services pds on pds.connection_id=dc.id
      where dc.id=$1 group by dc.id`,
    [id]
  )
  if (!rows[0]) throw new ApiError('Data connection not found', 404)
  return rows[0]
}

function connectionPassword(connection: SecretConnection) {
  return connection.password_ciphertext ? decryptSecret(connection.password_ciphertext) : ''
}

export async function listDataConnections() {
  await ensureDataServicesSchema()
  const { rows } = await query<DataConnection>(
    `select dc.id,dc.name,dc.provider,dc.host,dc.port,dc.username,dc.tls_enabled,dc.options,
            dc.purpose,dc.managed,dc.is_default,dc.provisioning_enabled,
            dc.last_status,dc.last_error,dc.last_tested_at,dc.created_at,dc.updated_at,
            count(pds.id)::int as service_count
       from data_connections dc left join project_data_services pds on pds.connection_id=dc.id
      group by dc.id order by dc.is_default desc,dc.managed desc,dc.name`
  )
  return rows
}

export async function createDataConnection(input: Record<string, unknown>, createdBy?: string | null) {
  await ensureDataServicesSchema()
  assertProvider(input.provider)
  const name = requiredText(input.name, 'Connection name')
  const host = requiredText(input.host, 'Host')
  const port = Number(input.port || DATA_PROVIDER_DEFAULT_PORTS[input.provider])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError('Port must be between 1 and 65535', 400)
  assertNotControlPlane(input.provider, host, port)
  const username = typeof input.username === 'string' && input.username.trim() ? input.username.trim() : null
  const password = typeof input.password === 'string' && input.password ? input.password : null
  const tlsEnabled = input.tlsEnabled === true
  const purpose = input.purpose || 'shared_application'
  assertPurpose(purpose)
  const isDefault = input.isDefault === true
  const provisioningEnabled = input.provisioningEnabled !== false

  try {
    const { rows } = await query<{ id: string }>(
      `insert into data_connections
        (name,provider,host,port,username,password_ciphertext,tls_enabled,options,purpose,is_default,provisioning_enabled,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [name, input.provider, host, port, username, password ? encryptSecret(password) : null, tlsEnabled, input.options || {}, purpose, false, provisioningEnabled, createdBy || null]
    )
    await testDataConnection(rows[0].id)
    if (isDefault) {
      await query('update data_connections set is_default=false,updated_at=now() where provider=$1 and id<>$2', [input.provider, rows[0].id])
      await query('update data_connections set is_default=true,updated_at=now() where id=$1', [rows[0].id])
    }
    return (await listDataConnections()).find((item) => item.id === rows[0].id)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ApiError('A data connection with this name already exists', 409)
    throw error
  }
}

export async function updateDataConnection(id: string, input: Record<string, unknown>) {
  const current = await getSecretConnection(id)
  if (current.managed && ['host', 'port', 'username'].some((field) => input[field] !== undefined)) {
    throw new ApiError('Installer-managed connection endpoints cannot be edited', 409)
  }
  const name = input.name === undefined ? current.name : requiredText(input.name, 'Connection name')
  const host = input.host === undefined ? current.host : requiredText(input.host, 'Host')
  const port = input.port === undefined ? current.port : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError('Port must be between 1 and 65535', 400)
  assertNotControlPlane(current.provider, host, port)
  const username = input.username === undefined ? current.username : (String(input.username || '').trim() || null)
  const passwordCiphertext = typeof input.password === 'string' && input.password
    ? encryptSecret(input.password)
    : current.password_ciphertext
  const tlsEnabled = input.tlsEnabled === undefined ? current.tls_enabled : input.tlsEnabled === true
  const purpose = input.purpose === undefined ? current.purpose : input.purpose
  assertPurpose(purpose)
  const provisioningEnabled = input.provisioningEnabled === undefined ? current.provisioning_enabled : input.provisioningEnabled === true
  await query(
    `update data_connections set name=$1,host=$2,port=$3,username=$4,password_ciphertext=$5,
       tls_enabled=$6,options=$7,purpose=$8,provisioning_enabled=$9,last_status='untested',last_error=null,updated_at=now() where id=$10`,
    [name, host, port, username, passwordCiphertext, tlsEnabled, input.options ?? current.options, purpose, provisioningEnabled, id]
  )
  await testDataConnection(id)
  if (input.isDefault === true) {
    await query('update data_connections set is_default=false,updated_at=now() where provider=$1 and id<>$2', [current.provider, id])
    await query('update data_connections set is_default=true,updated_at=now() where id=$1', [id])
  }
  return (await listDataConnections()).find((item) => item.id === id)
}

export async function deleteDataConnection(id: string) {
  const current = await getSecretConnection(id)
  if (current.managed) throw new ApiError('Installer-managed connections cannot be deleted from Manager', 409)
  if (current.service_count > 0) throw new ApiError('Detach all project data services before deleting this connection', 409)
  await query('delete from data_connections where id=$1', [id])
}

async function testProvider(connection: SecretConnection) {
  const password = connectionPassword(connection)
  if (connection.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: connection.host, port: connection.port, user: connection.username || undefined, password, database: String(connection.options.database || 'postgres'), ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000 })
    await client.connect()
    try { await client.query('select 1') } finally { await client.end() }
    return
  }
  if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.username || undefined, password, database: String(connection.options.database || ''), ssl: connection.tls_enabled ? {} : undefined, connectTimeout: 10_000 })
    try { await client.query('select 1') } finally { await client.end() }
    return
  }
  if (connection.provider === 'sqlserver') {
    const sql = await import('mssql')
    const pool = await sql.connect({ server: connection.host, port: connection.port, user: connection.username || undefined, password, database: String(connection.options.database || 'master'), options: { encrypt: connection.tls_enabled, trustServerCertificate: !connection.tls_enabled }, connectionTimeout: 10_000 })
    try { await pool.request().query('select 1 as ok') } finally { await pool.close() }
    return
  }
  if (connection.provider === 'mongodb') {
    const { MongoClient } = await import('mongodb')
    const auth = connection.username ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(password)}@` : ''
    const client = new MongoClient(`mongodb://${auth}${connection.host}:${connection.port}/?authSource=${encodeURIComponent(String(connection.options.authSource || 'admin'))}`, { connectTimeoutMS: 10_000, tls: connection.tls_enabled })
    await client.connect()
    try { await client.db('admin').command({ ping: 1 }) } finally { await client.close() }
    return
  }
  const { createClient } = await import('redis')
  const auth = connection.username ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(password)}@` : password ? `:${encodeURIComponent(password)}@` : ''
  const client = createClient({ url: `${connection.tls_enabled ? 'rediss' : 'redis'}://${auth}${connection.host}:${connection.port}` })
  await client.connect()
  try { await client.ping() } finally { await client.quit() }
}

export async function testDataConnection(id: string) {
  const connection = await getSecretConnection(id)
  try {
    await testProvider(connection)
    await query(`update data_connections set last_status='healthy',last_error=null,last_tested_at=now(),updated_at=now() where id=$1`, [id])
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : 'Connection failed'
    await query(`update data_connections set last_status='failed',last_error=$2,last_tested_at=now(),updated_at=now() where id=$1`, [id, message])
    throw new ApiError(message, 400)
  }
}

export async function configureManagedMySqlRuntime() {
  await ensureDataServicesSchema()
  const existingResult = await query<SecretConnection>(`select dc.*,count(pds.id)::int as service_count from data_connections dc left join project_data_services pds on pds.connection_id=dc.id where dc.provider='mysql' group by dc.id order by dc.managed desc,dc.created_at limit 1`)
  const existing = existingResult.rows[0]
  if (existing) {
    try {
      await testProvider(existing)
      await query(`update data_connections set managed=true,last_status='healthy',last_error=null,last_tested_at=now(),updated_at=now() where id=$1`, [existing.id])
      return { connectionId: existing.id, reused: true }
    } catch {
      // A freshly installed local MySQL instance is secured below.
    }
  }

  const mysql = await import('mysql2/promise')
  const host = '127.0.0.1'
  const port = 3306
  const username = 'manager_project_admin'
  const secret = newPassword()
  let client
  try {
    client = await mysql.createConnection({ host, port, user: 'root', password: '', connectTimeout: 10_000 })
  } catch {
    throw new ApiError('MySQL is running, but Manager could not secure it automatically. Update the MySQL connection with a valid administrator credential.', 409)
  }
  try {
    const escaped = client.escape(secret)
    for (const accountHost of ['localhost', '127.0.0.1']) {
      const account = `'${username}'@'${accountHost}'`
      await client.query(`create user if not exists ${account} identified by ${escaped}`)
      await client.query(`alter user ${account} identified by ${escaped}`)
      await client.query(`grant all privileges on *.* to ${account} with grant option`)
    }
    await client.query('flush privileges')
    const verification = await mysql.createConnection({ host, port, user: username, password: secret, connectTimeout: 10_000 })
    try { await verification.query('select 1') } finally { await verification.end() }
    await query(`update data_connections set is_default=false,updated_at=now() where provider='mysql'`)
    let connectionId: string
    if (existing) {
      await query(
        `update data_connections set name='Managed application MySQL',host=$1,port=$2,username=$3,password_ciphertext=$4,
           tls_enabled=false,purpose='shared_application',managed=true,is_default=true,provisioning_enabled=true,
           last_status='healthy',last_error=null,last_tested_at=now(),updated_at=now() where id=$5`,
        [host, port, username, encryptSecret(secret), existing.id]
      )
      connectionId = existing.id
    } else {
      const { rows } = await query<{ id: string }>(
        `insert into data_connections
          (name,provider,host,port,username,password_ciphertext,tls_enabled,purpose,managed,is_default,provisioning_enabled,last_status,last_tested_at)
         values ('Managed application MySQL','mysql',$1,$2,$3,$4,false,'shared_application',true,true,true,'healthy',now()) returning id`,
        [host, port, username, encryptSecret(secret)]
      )
      connectionId = rows[0].id
    }
    await client.query(`alter user 'root'@'localhost' identified by ${escaped}`)
    await client.query('flush privileges')
    return { connectionId, reused: false }
  } finally { await client.end() }
}

async function provisionProviderDatabase(connection: SecretConnection, databaseName: string, username: string, password: string) {
  const adminPassword = connectionPassword(connection)
  if (connection.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, database: String(connection.options.database || 'postgres'), ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false })
    await client.connect()
    try {
      await client.query(`create role ${quotePg(username)} login password '${sqlLiteral(password)}'`)
      await client.query(`create database ${quotePg(databaseName)} owner ${quotePg(username)}`)
    } catch (error) {
      await client.query(`drop role if exists ${quotePg(username)}`).catch(() => undefined)
      throw error
    } finally { await client.end() }
    return
  }
  if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, ssl: connection.tls_enabled ? {} : undefined })
    const db = `\`${databaseName.replace(/`/g, '``')}\``
    const user = client.escape(username)
    const secret = client.escape(password)
    let databaseCreated = false
    let userCreated = false
    try {
      await client.query(`create database ${db}`)
      databaseCreated = true
      await client.query(`create user ${user}@'%' identified by ${secret}`)
      userCreated = true
      await client.query(`grant all privileges on ${db}.* to ${user}@'%'`)
    } catch (error) {
      if (userCreated) await client.query(`drop user if exists ${user}@'%'`).catch(() => undefined)
      if (databaseCreated) await client.query(`drop database if exists ${db}`).catch(() => undefined)
      throw error
    } finally { await client.end() }
    return
  }
  if (connection.provider === 'sqlserver') {
    const sql = await import('mssql')
    const config = { server: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, database: 'master', options: { encrypt: connection.tls_enabled, trustServerCertificate: !connection.tls_enabled } }
    const master = await new sql.ConnectionPool(config).connect()
    try {
      await master.request().query(`create login ${quoteSqlServer(username)} with password=N'${sqlLiteral(password)}'; create database ${quoteSqlServer(databaseName)}`)
    } finally { await master.close() }
    const appDb = await new sql.ConnectionPool({ ...config, database: databaseName }).connect()
    try { await appDb.request().query(`create user ${quoteSqlServer(username)} for login ${quoteSqlServer(username)}; alter role db_owner add member ${quoteSqlServer(username)}`) } finally { await appDb.close() }
    return
  }
  if (connection.provider === 'mongodb') {
    const { MongoClient } = await import('mongodb')
    const auth = connection.username ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(adminPassword)}@` : ''
    const client = new MongoClient(`mongodb://${auth}${connection.host}:${connection.port}/?authSource=${encodeURIComponent(String(connection.options.authSource || 'admin'))}`, { tls: connection.tls_enabled })
    await client.connect()
    try { await client.db(databaseName).command({ createUser: username, pwd: password, roles: [{ role: 'readWrite', db: databaseName }] }) } finally { await client.close() }
  }
}

async function testProjectServiceCredential(connection: SecretConnection, databaseName: string, username: string | null, password: string) {
  if (connection.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: connection.host, port: connection.port, user: username || undefined, password, database: databaseName, ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000 })
    await client.connect()
    try { await client.query('select 1') } finally { await client.end() }
    return
  }
  if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: username || undefined, password, database: databaseName, ssl: connection.tls_enabled ? {} : undefined, connectTimeout: 10_000 })
    try { await client.query('select 1') } finally { await client.end() }
    return
  }
  if (connection.provider === 'sqlserver') {
    const sql = await import('mssql')
    const pool = await new sql.ConnectionPool({ server: connection.host, port: connection.port, user: username || undefined, password, database: databaseName, options: { encrypt: connection.tls_enabled, trustServerCertificate: !connection.tls_enabled }, connectionTimeout: 10_000 }).connect()
    try { await pool.request().query('select 1 as ok') } finally { await pool.close() }
    return
  }
  if (connection.provider === 'mongodb') {
    const { MongoClient } = await import('mongodb')
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : ''
    const client = new MongoClient(`mongodb://${auth}${connection.host}:${connection.port}/${encodeURIComponent(databaseName)}?authSource=${encodeURIComponent(String(connection.options.authSource || databaseName))}`, { connectTimeoutMS: 10_000, tls: connection.tls_enabled })
    await client.connect()
    try { await client.db(databaseName).command({ ping: 1 }) } finally { await client.close() }
    return
  }
  const { createClient } = await import('redis')
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : password ? `:${encodeURIComponent(password)}@` : ''
  const client = createClient({ url: `${connection.tls_enabled ? 'rediss' : 'redis'}://${auth}${connection.host}:${connection.port}/${databaseName}` })
  await client.connect()
  try { await client.ping() } finally { await client.quit() }
}

export async function listProjectDataServices(projectId?: string) {
  await ensureDataServicesSchema()
  const { ensureDataMigrationSchema } = await import('@/lib/data-migrations')
  await ensureDataMigrationSchema()
  const params = projectId ? [projectId] : []
  const where = projectId ? 'where pds.project_id=$1' : ''
  const { rows } = await query<ProjectDataService & DataServiceRemovalFacts>(
    `select pds.id,pds.project_id,p.name as project_name,p.environment,pds.connection_id,
            dc.name as connection_name,dc.provider,dc.host,dc.port,dc.tls_enabled,
            pds.name,pds.database_name,pds.username,pds.env_prefix,pds.application_primary,pds.options,pds.created_at,pds.updated_at,
            exists(select 1 from deployments d where d.project_id=pds.project_id and d.status in ('queued','running')) as deployment_active,
            bs.last_status as backup_status,
            (select count(*)::int from data_migration_jobs m where m.source_service_id=pds.id or m.target_service_id=pds.id) as migration_count,
            exists(select 1 from data_migration_jobs m where (m.source_service_id=pds.id or m.target_service_id=pds.id) and m.status in ('queued','running','validating')) as migration_active
       from project_data_services pds
       join projects p on p.id=pds.project_id
       join data_connections dc on dc.id=pds.connection_id
       left join data_service_backup_schedules bs on bs.service_id=pds.id
       ${where} order by p.name,p.environment,pds.name`,
    params
  )
  return rows.map((service) => ({ ...service, removal_blocked_reason: dataServiceRemovalReason(service) }))
}

export async function provisionProjectDataService(projectId: string, input: Record<string, unknown>, createdBy?: string | null) {
  await ensureDataServicesSchema()
  const { rows } = await query<{ slug: string; environment: string; project_type: string }>('select slug,environment,project_type from projects where id=$1', [projectId])
  const project = rows[0]
  if (!project) throw new ApiError('Project not found', 404)
  if (project.project_type === 'angular') throw new ApiError('Browser applications must access databases through a backend API', 400)
  const connection = await getSecretConnection(requiredText(input.connectionId, 'Data connection'))
  assertNotControlPlane(connection.provider, connection.host, connection.port)
  const attachExisting = input.mode === 'existing'
  if (!attachExisting && !connection.provisioning_enabled) throw new ApiError('Provisioning is disabled for this data connection', 409)
  if (!attachExisting && connection.last_status !== 'healthy') throw new ApiError('Test this data connection successfully before provisioning', 409)
  const name = safeName(requiredText(input.name, 'Service name'), 40)
  const suffix = project.environment === 'staging' ? '_staging' : '_production'
  const requestedDatabase = attachExisting
    ? requiredText(input.databaseName, 'Existing database name')
    : typeof input.databaseName === 'string' && input.databaseName.trim()
    ? input.databaseName.trim()
    : `${safeName(`${project.slug}_${name}`, 50)}${suffix}`
  const databaseName = attachExisting
    ? requestedDatabase.slice(0, 128)
    : connection.provider === 'redis' ? String(Number(input.databaseName || 0)) : safeName(requestedDatabase, connection.provider === 'postgresql' ? 63 : 64)
  const usernameMaxLength = connection.provider === 'postgresql' ? 63 : ['mysql', 'mariadb'].includes(connection.provider) ? 32 : 128
  const requestedUsername = typeof input.username === 'string' ? input.username.trim() : ''
  const username = attachExisting
    ? (requiredText(input.username, 'Database username') || null)
    : connection.provider === 'redis' ? connection.username : safeName(requestedUsername || `${databaseName}_user`, usernameMaxLength)
  const requestedPassword = typeof input.password === 'string' ? input.password : ''
  if (!attachExisting && requestedPassword && (requestedPassword.length < 16 || requestedPassword.length > 256)) {
    throw new ApiError('Custom database passwords must be between 16 and 256 characters', 400)
  }
  const password = attachExisting ? requestedPassword : connection.provider === 'redis' ? connectionPassword(connection) : requestedPassword || newPassword()
  if (attachExisting) {
    try {
      await testProjectServiceCredential(connection, databaseName, username, password)
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message.slice(0, 1000) : 'Existing database credential could not be verified', 400)
    }
  } else if (connection.provider !== 'redis') {
    await provisionProviderDatabase(connection, databaseName, username as string, password)
  }

  try {
    const { rows: inserted } = await query<{ id: string }>(
      `insert into project_data_services
        (project_id,connection_id,name,database_name,username,password_ciphertext,env_prefix,options,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [projectId, connection.id, name, databaseName, username, password ? encryptSecret(password) : null, envPrefix(String(input.envPrefix || name)), { ...(typeof input.options === 'object' && input.options ? input.options : {}), ownership: attachExisting ? 'external' : 'manager' }, createdBy || null]
    )
    if (connection.provider === 'postgresql' && input.backupEnabled !== false) {
      const { configureDataServiceBackup } = await import('@/lib/data-service-backups')
      await configureDataServiceBackup(inserted[0].id, {
        frequency: input.backupFrequency || 'daily',
        timeOfDay: input.backupTimeOfDay || '03:00',
        timezone: input.backupTimezone || 'UTC',
        dayOfWeek: input.backupDayOfWeek ?? 0,
        dayOfMonth: input.backupDayOfMonth ?? 1,
        monthOfYear: input.backupMonthOfYear ?? 1,
        retentionCount: input.backupRetentionCount || 30,
        enabled: true,
      }, createdBy)
    }
    if (input.applicationPrimary === true) {
      await setProjectDataServiceApplicationPrimary(projectId, inserted[0].id, true)
    }
    return (await listProjectDataServices(projectId)).find((item) => item.id === inserted[0].id)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ApiError('This project already has a service with that name or environment prefix', 409)
    throw error
  }
}

export async function detachProjectDataService(projectId: string, serviceId: string) {
  await ensureDataServicesSchema()
  const { ensureDataMigrationSchema } = await import('@/lib/data-migrations')
  await ensureDataMigrationSchema()
  const releaseOperation = await acquireProjectOperation(projectId)
  try {
    const client = await db.connect()
    try {
      await client.query('begin')
      // Parent and schedule locks serialize new migrations, primary selection and backup claims.
      const { rows } = await client.query<{ application_primary: boolean }>(
        'select application_primary from project_data_services where id=$1 and project_id=$2 for update', [serviceId, projectId])
      if (!rows[0]) throw new ApiError('Project data service not found', 404)
      const backup = await client.query<{ last_status: string }>('select last_status from data_service_backup_schedules where service_id=$1 for update', [serviceId])
      const migrations = await client.query<{ migration_count: number; migration_active: boolean }>(
        `select count(*)::int as migration_count,coalesce(bool_or(status in ('queued','running','validating')),false) as migration_active
           from data_migration_jobs where source_service_id=$1 or target_service_id=$1`, [serviceId])
      const reason = dataServiceRemovalReason({ ...rows[0], ...migrations.rows[0], deployment_active: false, backup_status: backup.rows[0]?.last_status || null })
      if (reason) throw new ApiError(reason, 409)
      await client.query('delete from project_data_services where id=$1 and project_id=$2', [serviceId, projectId])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      if ((error as { code?: string }).code === '23503') throw new ApiError('This resource is still referenced by another operation. Refresh and remove its migration history first.', 409)
      throw error
    } finally { client.release() }
  } finally { await releaseOperation() }
}

export async function setProjectDataServiceApplicationPrimary(projectId: string, serviceId: string, active: boolean) {
  await ensureDataServicesSchema()
  const client = await db.connect()
  try {
    await client.query('begin')
    const service = await client.query<{ id: string }>('select id from project_data_services where id=$1 and project_id=$2 for update', [serviceId, projectId])
    if (!service.rows[0]) throw new ApiError('Project data service not found', 404)
    if (active) {
      await client.query('update project_data_services set application_primary=false,updated_at=now() where project_id=$1 and application_primary=true', [projectId])
    }
    await client.query('update project_data_services set application_primary=$1,updated_at=now() where id=$2 and project_id=$3', [active, serviceId, projectId])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
  return (await listProjectDataServices(projectId)).find((item) => item.id === serviceId)
}

async function setProjectServicePassword(connection: SecretConnection, service: ProjectDataService, password: string) {
  const adminPassword = connectionPassword(connection)
  if (!service.username) throw new ApiError('This data service has no individual database user', 409)
  if (connection.provider === 'postgresql') {
    const { Client } = await import('pg')
    const client = new Client({ host: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, database: String(connection.options.database || 'postgres'), ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false })
    await client.connect()
    try { await client.query(`alter role ${quotePg(service.username)} password '${sqlLiteral(password)}'`) } finally { await client.end() }
    return
  }
  if (connection.provider === 'mysql' || connection.provider === 'mariadb') {
    const mysql = await import('mysql2/promise')
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, ssl: connection.tls_enabled ? {} : undefined })
    try { await client.query(`alter user ${client.escape(service.username)}@'%' identified by ${client.escape(password)}`) } finally { await client.end() }
    return
  }
  if (connection.provider === 'sqlserver') {
    const sql = await import('mssql')
    const pool = await new sql.ConnectionPool({ server: connection.host, port: connection.port, user: connection.username || undefined, password: adminPassword, database: 'master', options: { encrypt: connection.tls_enabled, trustServerCertificate: !connection.tls_enabled } }).connect()
    try { await pool.request().query(`alter login ${quoteSqlServer(service.username)} with password=N'${sqlLiteral(password)}'`) } finally { await pool.close() }
    return
  }
  if (connection.provider === 'mongodb') {
    const { MongoClient } = await import('mongodb')
    const auth = connection.username ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(adminPassword)}@` : ''
    const client = new MongoClient(`mongodb://${auth}${connection.host}:${connection.port}/?authSource=${encodeURIComponent(String(connection.options.authSource || 'admin'))}`, { tls: connection.tls_enabled })
    await client.connect()
    try { await client.db(service.database_name).command({ updateUser: service.username, pwd: password }) } finally { await client.close() }
    return
  }
  throw new ApiError('This provider does not support per-service password rotation', 409)
}

export async function rotateProjectDataServicePassword(projectId: string, serviceId: string, requestedPassword: unknown) {
  await ensureDataServicesSchema()
  const password = typeof requestedPassword === 'string' ? requestedPassword : ''
  if (password.length < 16 || password.length > 256) throw new ApiError('Password must be between 16 and 256 characters', 400)
  const { rows } = await query<ProjectDataService & { password_ciphertext: string | null }>(
    `select pds.*,p.name as project_name,p.environment,dc.name as connection_name,dc.provider,dc.host,dc.port,dc.tls_enabled
       from project_data_services pds join projects p on p.id=pds.project_id
       join data_connections dc on dc.id=pds.connection_id where pds.id=$1 and pds.project_id=$2`,
    [serviceId, projectId]
  )
  const service = rows[0]
  if (!service) throw new ApiError('Project data service not found', 404)
  if (service.options?.ownership === 'external') throw new ApiError('Manager cannot rotate credentials owned by an external database', 409)
  const connection = await getSecretConnection(service.connection_id)
  const previousPassword = service.password_ciphertext ? decryptSecret(service.password_ciphertext) : ''
  await setProjectServicePassword(connection, service, password)
  try {
    await testProjectServiceCredential(connection, service.database_name, service.username, password)
    await query('update project_data_services set password_ciphertext=$1,updated_at=now() where id=$2', [encryptSecret(password), service.id])
  } catch (error) {
    if (previousPassword) await setProjectServicePassword(connection, service, previousPassword).catch(() => undefined)
    throw error
  }
  return { id: service.id, username: service.username }
}

function serviceUrl(service: ProjectDataService, password: string) {
  const auth = service.username ? `${encodeURIComponent(service.username)}:${encodeURIComponent(password)}@` : password ? `:${encodeURIComponent(password)}@` : ''
  const protocol = service.provider === 'postgresql' ? 'postgresql' : service.provider === 'sqlserver' ? 'sqlserver' : service.provider
  const database = service.provider === 'redis' ? service.database_name : encodeURIComponent(service.database_name)
  return `${protocol}${service.tls_enabled && service.provider === 'redis' ? 's' : ''}://${auth}${service.host}:${service.port}/${database}`
}

export async function getProjectDataServiceEnv(projectId: string) {
  await ensureDataServicesSchema()
  const { rows } = await query<ProjectDataService & { password_ciphertext: string | null; project_type: string }>(
    `select pds.*,p.name as project_name,p.environment,p.project_type,dc.name as connection_name,dc.provider,dc.host,dc.port,dc.tls_enabled
       from project_data_services pds join projects p on p.id=pds.project_id
       join data_connections dc on dc.id=pds.connection_id where pds.project_id=$1 order by pds.created_at`,
    [projectId]
  )
  const env: Record<string, string> = {}
  for (const service of rows) {
    const password = service.password_ciphertext ? decryptSecret(service.password_ciphertext) : ''
    const url = serviceUrl(service, password)
    // Secondary services stay namespaced. The active application database uses
    // only the framework's canonical variables so credentials are not duplicated.
    if (!service.application_primary && service.options?.injectEnv !== false) {
      const prefix = service.env_prefix
      env[`${prefix}_URL`] = url
      env[`${prefix}_HOST`] = service.host
      env[`${prefix}_PORT`] = String(service.port)
      env[`${prefix}_DATABASE`] = service.database_name
      if (service.username) env[`${prefix}_USER`] = service.username
      if (password) env[`${prefix}_PASSWORD`] = password
    }
    if (service.application_primary) {
      if (service.project_type === 'laravel' && ['postgresql', 'mysql', 'mariadb', 'sqlserver'].includes(service.provider)) {
        env.DB_CONNECTION = service.provider === 'postgresql' ? 'pgsql' : service.provider === 'sqlserver' ? 'sqlsrv' : 'mysql'
        env.DB_HOST = service.host
        env.DB_PORT = String(service.port)
        env.DB_DATABASE = service.database_name
        if (service.username) env.DB_USERNAME = service.username
        if (password) env.DB_PASSWORD = password
      }
      if (['next', 'node'].includes(service.project_type)) {
        env.DATABASE_URL = url
        env.DATABASE_HOST = service.host
        env.DATABASE_PORT = String(service.port)
        env.DATABASE_NAME = service.database_name
        if (service.username) env.DATABASE_USER = service.username
        if (password) env.DATABASE_PASSWORD = password
      }
      if (service.project_type === 'go') {
        env.DATABASE_URL = url
        env.DB_DRIVER = service.provider === 'postgresql' ? 'postgres' : service.provider
        env.DB_HOST = service.host
        env.DB_PORT = String(service.port)
        env.DB_NAME = service.database_name
        if (service.username) env.DB_USER = service.username
        if (password) env.DB_PASSWORD = password
      }
    }
    if (service.provider === 'mongodb' && service.application_primary) env.MONGODB_URI = url
    if (service.provider === 'redis' && service.application_primary) env.REDIS_URL = url
  }
  return env
}
