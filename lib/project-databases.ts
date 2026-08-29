import { ApiError } from '@/lib/api'
import { createDatabase, rotateDatabaseRolePassword } from '@/lib/db-admin'
import { query } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'

export interface ProjectDatabase {
  project_id: string
  project_name: string
  environment: 'production' | 'staging'
  database_name: string
  role_name: string
  created_at: string
  updated_at: string
}

let schemaPromise: Promise<void> | null = null

export function ensureProjectDatabaseSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      create table if not exists project_databases (
        project_id uuid primary key references projects(id) on delete cascade,
        database_name text unique not null,
        role_name text unique not null,
        password_ciphertext text not null,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `).then(() => undefined).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

function postgresIdentifier(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  const safe = /^[a-z_]/.test(normalized) ? normalized : `app_${normalized}`
  return safe.slice(0, 63)
}

function namesForProject(slug: string, environment: string) {
  const suffix = environment === 'staging' ? '_staging' : '_production'
  const base = postgresIdentifier(slug.replace(/-staging$/, ''))
  const databaseName = `${base.slice(0, 63 - suffix.length)}${suffix}`
  return {
    databaseName,
    roleName: postgresIdentifier(`${databaseName.slice(0, 58)}_user`),
  }
}

export async function getProjectDatabase(projectId: string) {
  await ensureProjectDatabaseSchema()
  const { rows } = await query<ProjectDatabase>(
    `select pd.project_id,p.name as project_name,p.environment,pd.database_name,pd.role_name,pd.created_at,pd.updated_at
       from project_databases pd join projects p on p.id=pd.project_id
      where pd.project_id=$1`,
    [projectId]
  )
  return rows[0] || null
}

export async function listProjectDatabases() {
  await ensureProjectDatabaseSchema()
  const { rows } = await query<ProjectDatabase>(
    `select pd.project_id,p.name as project_name,p.environment,pd.database_name,pd.role_name,pd.created_at,pd.updated_at
       from project_databases pd join projects p on p.id=pd.project_id
      order by p.name,p.environment`
  )
  return rows
}

export async function provisionProjectDatabase(projectId: string, createdBy?: string | null) {
  await ensureProjectDatabaseSchema()
  const existing = await getProjectDatabase(projectId)
  if (existing) throw new ApiError('This project environment already has a database', 409)

  const { rows } = await query<{ id: string; slug: string; environment: string; project_type: string }>(
    'select id,slug,environment,project_type from projects where id=$1',
    [projectId]
  )
  const project = rows[0]
  if (!project) throw new ApiError('Project not found', 404)
  if (project.project_type === 'angular') {
    throw new ApiError('Angular runs in the browser and must access data through a backend API, not a database credential', 400)
  }

  const { databaseName, roleName } = namesForProject(project.slug, project.environment)
  const created = await createDatabase(databaseName, { withOwner: true, ownerName: roleName })
  if (!created.owner) throw new Error('Database owner credentials were not created')

  await query(
    `insert into project_databases (project_id,database_name,role_name,password_ciphertext,created_by)
     values ($1,$2,$3,$4,$5)`,
    [projectId, databaseName, roleName, encryptSecret(created.owner.password), createdBy || null]
  )
  return getProjectDatabase(projectId)
}

export async function rotateProjectDatabasePassword(projectId: string) {
  await ensureProjectDatabaseSchema()
  const { rows } = await query<{ role_name: string }>('select role_name from project_databases where project_id=$1', [projectId])
  if (!rows[0]) throw new ApiError('This project has no managed database', 404)
  const password = await rotateDatabaseRolePassword(rows[0].role_name)
  await query(
    'update project_databases set password_ciphertext=$1,updated_at=now() where project_id=$2',
    [encryptSecret(password), projectId]
  )
  return getProjectDatabase(projectId)
}

export async function getProjectDatabaseEnv(projectId: string): Promise<Record<string, string>> {
  await ensureProjectDatabaseSchema()
  const { rows } = await query<{ database_name: string; role_name: string; password_ciphertext: string }>(
    'select database_name,role_name,password_ciphertext from project_databases where project_id=$1',
    [projectId]
  )
  if (!rows[0]) return {}
  const password = decryptSecret(rows[0].password_ciphertext)
  const host = process.env.DATABASE_HOST || '127.0.0.1'
  const port = process.env.DATABASE_PORT || '5432'
  const databaseUrl = `postgresql://${encodeURIComponent(rows[0].role_name)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(rows[0].database_name)}`
  return {
    DATABASE_URL: databaseUrl,
    DATABASE_HOST: host,
    DATABASE_PORT: port,
    DATABASE_NAME: rows[0].database_name,
    DATABASE_USER: rows[0].role_name,
    DATABASE_PASSWORD: password,
    DB_CONNECTION: 'pgsql',
    DB_HOST: host,
    DB_PORT: port,
    DB_DATABASE: rows[0].database_name,
    DB_USERNAME: rows[0].role_name,
    DB_PASSWORD: password,
  }
}

export async function getProjectDatabaseUrl(projectId: string) {
  const env = await getProjectDatabaseEnv(projectId)
  if (!env.DATABASE_URL) throw new ApiError('This project has no managed database', 404)
  return `${env.DATABASE_URL}?sslmode=disable`
}
