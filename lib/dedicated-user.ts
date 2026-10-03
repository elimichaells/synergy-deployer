import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { encryptSecret } from '@/lib/secret-crypto'
import { connectionPassword, getSecretConnection } from '@/lib/data-services'
import { databaseKey } from '@/lib/database-discovery-policy'
import { ownershipStatement, quoteIdent, rewriteEnvCredentials, roleNameFor, type OwnedObject } from '@/lib/dedicated-user-policy'
import { discoverDatabases, getStorageDatabase } from '@/lib/storage'
import { envBackupDir } from '@/lib/paths'

// Moves a database from a superuser login to a dedicated, limited database user:
// create the user, hand it ownership of the app's objects, then switch each app's
// .env and restart it. The superuser keeps working throughout, so any failure is
// undone by putting the original files back.

const ENV_FILES = ['.env', '.env.local', '.env.production']

async function withClient<T>(serverId: string, database: string, fn: (client: import('pg').Client) => Promise<T>, login?: { user: string; password: string }) {
  const connection = await getSecretConnection(serverId)
  const { Client } = await import('pg')
  const client = new Client({ host: connection.host, port: connection.port, database, user: login?.user || connection.username || undefined,
    password: login?.password ?? connectionPassword(connection), ssl: connection.tls_enabled ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000 })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

/** Objects in the app's schemas, split into those a superuser owns and those some other user owns. */
export async function inventory(client: import('pg').Client) {
  const { rows } = await client.query<OwnedObject & { owner: string; owner_is_super: boolean }>(`
    with objects as (
      select 'schema'::text as kind, n.nspname as schema, n.nspname as name, null::text as args, n.nspowner as owner_oid from pg_namespace n
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and not exists (select 1 from pg_depend d where d.classid='pg_namespace'::regclass and d.objid=n.oid and d.deptype='e')
      union all
      select c.relkind::text, n.nspname, c.relname, null, c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')
         and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
         -- Serial and identity sequences follow their table automatically.
         and not (c.relkind='S' and exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype in ('a','i')))
      union all
      select case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, n.nspname, p.proname,
             pg_get_function_identity_arguments(p.oid), p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      union all
      select case t.typtype when 'd' then 'domain' else 'type' end, n.nspname, t.typname, null, t.typowner from pg_type t join pg_namespace n on n.oid=t.typnamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and t.typtype in ('e','d','r') and t.typrelid = 0
         and not exists (select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')
    )
    -- pg_database_owner (the default owner of "public" since PostgreSQL 15) follows the database owner automatically.
    select o.kind, o.schema, o.name, o.args, r.rolname as owner, r.rolsuper as owner_is_super
      from objects o join pg_roles r on r.oid=o.owner_oid where r.rolname <> 'pg_database_owner'`)
  return rows
}

export interface ConversionPlan {
  serviceId: string
  database: string
  serverName: string
  currentUser: string | null
  roleName: string
  objectCount: number
  objectKinds: Record<string, number>
  apps: { serviceId: string; projectId: string; name: string; environment: string; files: { file: string; changes: number }[] }[]
  blockers: string[]
  notes: string[]
}

const kindLabels: Record<string, string> = { r: 'tables', p: 'tables', v: 'views', m: 'materialized views', S: 'sequences', f: 'foreign tables', schema: 'schemas', function: 'functions', procedure: 'procedures', aggregate: 'aggregates', type: 'types', domain: 'domains' }

export async function planDedicatedUser(serviceId: string): Promise<ConversionPlan & { objects: OwnedObject[]; oldUsers: string[] }> {
  const database = await getStorageDatabase(serviceId)
  const blockers: string[] = []
  const notes: string[] = []
  if (database.engine !== 'postgresql') blockers.push('Available for PostgreSQL databases')
  if (database.serverRole === 'external') blockers.push('Synergy has no admin access to this server')
  const plan: ConversionPlan & { objects: OwnedObject[]; oldUsers: string[] } = {
    serviceId: database.id, database: database.database, serverName: database.serverName, currentUser: null, roleName: '', objectCount: 0, objectKinds: {},
    apps: [], blockers, notes, objects: [], oldUsers: [],
  }
  if (blockers.length) return plan

  const superusers = new Set((await withClient(database.serverId, 'postgres', async client => (await client.query<{ rolname: string }>('select rolname from pg_roles where rolsuper')).rows)).map(row => row.rolname))
  const takenRoles = new Set((await withClient(database.serverId, 'postgres', async client => (await client.query<{ rolname: string }>('select rolname from pg_roles')).rows)).map(row => row.rolname))
  const users = [...new Set(database.apps.map(app => app.username).filter((name): name is string => !!name))]
  plan.oldUsers = users
  plan.currentUser = users.join(', ') || null
  if (!users.some(user => superusers.has(user))) blockers.push('Its apps already use a dedicated, non-superuser account')
  if (users.length > 1) blockers.push(`Its apps sign in as different users (${users.join(', ')}); give them one account first`)
  plan.roleName = roleNameFor(database.database, takenRoles)

  // Every app that points at this database must be linked, or it would be left on the old account.
  const key = databaseKey('postgresql', database.host, database.port, database.database)
  const unlinked = (await discoverDatabases()).filter(item => !item.linked && databaseKey(item.engine, item.host, item.port, item.database) === key)
  if (unlinked.length) blockers.push(`Link ${[...new Set(unlinked.map(item => item.projectName))].join(', ')} to this database first, so ${unlinked.length === 1 ? 'it switches' : 'they switch'} too`)

  const running = await query<{ name: string }>(`select distinct p.name from deployments d join projects p on p.id=d.project_id where d.status in ('queued','running') and d.project_id = any($1::uuid[])`, [database.apps.map(app => app.projectId)])
  if (running.rows.length) blockers.push(`Wait for the running deployment of ${running.rows.map(row => row.name).join(', ')} to finish`)

  const objects = await withClient(database.serverId, database.database, inventory)
  const transferable = objects.filter(object => object.owner_is_super || users.includes(object.owner))
  const foreign = objects.filter(object => !object.owner_is_super && !users.includes(object.owner))
  if (foreign.length) blockers.push(`${foreign.length} object(s) belong to other users (for example ${foreign.slice(0, 3).map(object => `${object.schema}.${object.name} owned by ${object.owner}`).join(', ')}). Sort these out before switching.`)
  plan.objects = transferable
  plan.objectCount = transferable.length
  for (const object of transferable) { const label = kindLabels[object.kind] || object.kind; plan.objectKinds[label] = (plan.objectKinds[label] || 0) + 1 }

  for (const app of database.apps) {
    const { rows } = await query<{ root_path: string }>('select root_path from projects where id=$1', [app.projectId])
    const files: { file: string; changes: number }[] = []
    for (const file of ENV_FILES) {
      const full = path.join(rows[0]?.root_path || '', file)
      if (!rows[0] || !existsSync(full)) continue
      const { changed } = rewriteEnvCredentials(await readFile(full, 'utf8'), { host: database.host, port: database.port, database: database.database, username: app.username || '' }, plan.roleName, 'placeholder')
      if (changed) files.push({ file, changes: changed })
    }
    if (!files.length) blockers.push(`Couldn't find ${app.name}'s database settings in its .env files`)
    plan.apps.push({ serviceId: app.serviceId, projectId: app.projectId, name: app.name, environment: app.environment, files })
  }
  const environments = new Set(database.apps.map(app => app.environment))
  if (environments.has('production') && environments.has('staging')) notes.push('Staging and production share this database, so both switch to the new user.')
  notes.push(`Each app restarts once (${database.apps.map(app => app.name).join(', ')}); expect a few seconds of downtime per app.`)
  notes.push('Your database data is not copied or moved. Only who owns it changes.')
  return plan
}

export async function transferOwnership(serverId: string, database: string, objects: OwnedObject[], owner: string) {
  await withClient(serverId, database, async client => {
    await client.query('begin')
    try {
      await client.query(`ALTER DATABASE ${quoteIdent(database)} OWNER TO ${quoteIdent(owner)}`)
      for (const object of objects) await client.query(ownershipStatement(object, owner))
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    }
  })
}

export async function convertToDedicatedUser(serviceId: string, userId?: string | null) {
  const plan = await planDedicatedUser(serviceId)
  if (plan.blockers.length) throw new ApiError(plan.blockers.join(' '), 409)
  const database = await getStorageDatabase(serviceId)
  const oldUser = plan.oldUsers[0]
  const steps: string[] = []
  const { acquireProjectOperation } = await import('@/lib/project-operation')
  const releases: (() => Promise<void>)[] = []
  try {
    for (const app of plan.apps) releases.push(await acquireProjectOperation(app.projectId))
    const password = randomBytes(24).toString('base64url')

    await withClient(database.serverId, 'postgres', client => client.query(
      `CREATE ROLE ${quoteIdent(plan.roleName)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`))
    steps.push(`Created the database user ${plan.roleName}`)
    const dropRole = () => withClient(database.serverId, 'postgres', client => client.query(`DROP ROLE IF EXISTS ${quoteIdent(plan.roleName)}`)).catch(() => undefined)

    try {
      await transferOwnership(database.serverId, database.database, plan.objects, plan.roleName)
    } catch (error) {
      await dropRole()
      throw new ApiError(`Ownership could not be transferred, so nothing was changed: ${(error as Error).message.slice(0, 300)}`, 500)
    }
    steps.push(`Gave ${plan.roleName} ownership of ${database.database} and ${plan.objectCount} objects`)

    const undoOwnership = async () => {
      await transferOwnership(database.serverId, database.database, plan.objects, oldUser).catch(() => undefined)
      await dropRole()
    }

    // Prove the new user can sign in and owns everything the app uses.
    try {
      const remaining = await withClient(database.serverId, database.database, async client => {
        const { rows } = await client.query<{ count: number }>(`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f')
            and c.relowner <> (select oid from pg_roles where rolname = current_user)
            and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`)
        return rows[0].count
      }, { user: plan.roleName, password })
      if (remaining > 0) throw new Error(`${remaining} tables are still owned by another user`)
    } catch (error) {
      await undoOwnership()
      throw new ApiError(`The new user could not be verified, so everything was put back: ${(error as Error).message.slice(0, 300)}`, 500)
    }
    steps.push(`Signed in as ${plan.roleName} and confirmed it owns every table`)

    // Switch each app's env files, keeping a copy of every original.
    const backups: { full: string; original: string }[] = []
    const stamp = new Date().toISOString().replace(/[-:.]/g, '')
    for (const app of plan.apps) {
      const { rows } = await query<{ root_path: string }>('select root_path from projects where id=$1', [app.projectId])
      const backupDirectory = path.join(envBackupDir(), app.projectId)
      await mkdir(backupDirectory, { recursive: true })
      for (const { file } of app.files) {
        const full = path.join(rows[0].root_path, file)
        const original = await readFile(full, 'utf8')
        await copyFile(full, path.join(backupDirectory, `${file.replace(/^\./, '')}-${stamp}-before-dedicated-user.bak`))
        const updated = rewriteEnvCredentials(original, { host: database.host, port: database.port, database: database.database, username: oldUser }, plan.roleName, password)
        await writeFile(full, updated.content, 'utf8')
        backups.push({ full, original })
      }
    }
    steps.push(`Updated ${backups.length} env file(s); originals saved under ${envBackupDir()}`)

    const { restartWithFreshEnvironment } = await import('@/lib/deploy')
    const restarted: string[] = []
    for (const app of plan.apps) {
      const result = await restartWithFreshEnvironment(app.projectId)
      restarted.push(app.projectId)
      if (!result.healthy) {
        // Put every app back on its original settings; the superuser still works.
        for (const backup of backups) await writeFile(backup.full, backup.original, 'utf8')
        for (const projectId of restarted) await restartWithFreshEnvironment(projectId).catch(() => undefined)
        await undoOwnership()
        throw new ApiError(`${app.name} did not come back healthy on the new user (${result.reason}). Every app was returned to its previous settings and the database to its previous owner.`, 500)
      }
      steps.push(`Restarted ${app.name} on the new user and confirmed it is healthy`)
    }

    await query(`update project_data_services set username=$1, password_ciphertext=$2, updated_at=now()
      where database_name=$3 and connection_id=(select connection_id from project_data_services where id=$4)`, [plan.roleName, encryptSecret(password), database.database, database.id])
    await query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null, 'storage.dedicated-user', `service:${database.id}`,
      { database: database.database, role: plan.roleName, previousUser: oldUser, apps: plan.apps.map(app => app.name) }])
    steps.push('Saved the new credentials (encrypted) in Synergy')
    return { role: plan.roleName, steps }
  } finally {
    for (const release of releases) await release().catch(() => undefined)
  }
}
