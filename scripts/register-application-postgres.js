const { createCipheriv, createHash, randomBytes } = require('crypto')
const path = require('path')
const { Client } = require('pg')

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function encryptSecret(value) {
  const secret = process.env.MANAGER_ENCRYPTION_KEY || process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) throw new Error('MANAGER_ENCRYPTION_KEY or JWT_SECRET is required')
  const key = createHash('sha256').update(`manager:secrets:${secret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

async function registerApplicationPostgres(controlClient) {
  const password = process.env.APP_POSTGRES_ADMIN_PASSWORD
  if (!password) return null
  const host = process.env.APP_POSTGRES_HOST || '127.0.0.1'
  const port = Number(process.env.APP_POSTGRES_PORT || 5433)
  const username = process.env.APP_POSTGRES_ADMIN_USER || 'manager_project_admin'
  const name = process.env.APP_POSTGRES_CONNECTION_NAME || 'Managed application PostgreSQL'
  const providerClient = new Client({ host, port, database: 'postgres', user: username, password, connectionTimeoutMillis: 10_000 })
  await providerClient.connect()
  try { await providerClient.query('select 1') } finally { await providerClient.end() }

  await controlClient.query('begin')
  try {
    await controlClient.query(`
      alter table data_connections add column if not exists purpose text not null default 'shared_application';
      alter table data_connections add column if not exists managed boolean not null default false;
      alter table data_connections add column if not exists is_default boolean not null default false;
      alter table data_connections add column if not exists provisioning_enabled boolean not null default true;
      create unique index if not exists data_connections_default_provider_idx on data_connections (provider) where is_default = true
    `)
    await controlClient.query(`update data_connections set is_default=false,updated_at=now() where provider='postgresql'`)
    const { rows } = await controlClient.query(
      `insert into data_connections
        (name,provider,host,port,username,password_ciphertext,tls_enabled,options,purpose,managed,is_default,provisioning_enabled,last_status,last_tested_at)
       values ($1,'postgresql',$2,$3,$4,$5,false,$6::jsonb,'shared_application',true,true,true,'healthy',now())
       on conflict (name) do update set
         host=excluded.host,port=excluded.port,username=excluded.username,
         password_ciphertext=excluded.password_ciphertext,options=excluded.options,
         purpose='shared_application',managed=true,is_default=true,provisioning_enabled=true,
         last_status='healthy',last_error=null,last_tested_at=now(),updated_at=now()
       returning id,name,host,port,last_status`,
      [name, host, port, username, encryptSecret(password), JSON.stringify({ database: 'postgres', serviceName: process.env.APP_POSTGRES_SERVICE_NAME || 'ManagerPostgreSQLApplications', managedBy: 'manager-installer' })]
    )
    await controlClient.query('commit')
    return rows[0]
  } catch (error) {
    await controlClient.query('rollback')
    throw error
  }
}

async function main() {
  require('dotenv').config({ path: process.env.MANAGER_ENV_PATH || path.join(process.cwd(), '.env.local') })
  const controlClient = new Client({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DATABASE_URL ? undefined : required('DATABASE_HOST'),
    port: process.env.DATABASE_URL ? undefined : Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_URL ? undefined : required('DATABASE_NAME'),
    user: process.env.DATABASE_URL ? undefined : required('DATABASE_USER'),
    password: process.env.DATABASE_URL ? undefined : required('DATABASE_PASSWORD'),
  })
  await controlClient.connect()
  try {
    const registered = await registerApplicationPostgres(controlClient)
    if (!registered) throw new Error('APP_POSTGRES_ADMIN_PASSWORD is required')
    console.log(`Registered ${registered.name} at ${registered.host}:${registered.port} (${registered.last_status})`)
  } finally { await controlClient.end() }
}

module.exports = { registerApplicationPostgres }

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1) })
