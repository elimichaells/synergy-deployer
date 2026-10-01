import type { PoolClient } from 'pg'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'

export const COMPONENT_ROLES = ['application', 'frontend', 'backend', 'service'] as const
let schema: Promise<void> | undefined
export function ensureApplicationGroupsSchema() {
  return schema ??= query(`
    create table if not exists application_groups (id uuid primary key default gen_random_uuid(),name text not null,created_at timestamptz not null default now());
    alter table projects add column if not exists application_group_id uuid references application_groups(id) on delete set null;
    alter table projects add column if not exists component_role text not null default 'application' check (component_role in ('application','frontend','backend','service'));
    create index if not exists projects_application_group_idx on projects(application_group_id);
  `).then(() => {}).catch(error => { schema = undefined; throw error })
}

export function componentRole(value: unknown) {
  if (typeof value !== 'string' || !(COMPONENT_ROLES as readonly string[]).includes(value)) throw new ApiError('Choose a valid application component role', 400)
  return value
}
export function projectIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new ApiError('Invalid related application', 400)
}

/** Puts a production application (and its staging copy) into a new project of its own. */
export async function assignOwnProject(client: Pick<PoolClient, 'query'>, productionId: string, options: { name?: string; role?: string } = {}) {
  const created = await client.query(
    `insert into application_groups (name) select coalesce($2, name) from projects where id=$1 returning id`, [productionId, options.name || null])
  const groupId = created.rows[0]?.id as string | undefined
  if (!groupId) throw new ApiError('Application not found', 404)
  await client.query(`update projects set application_group_id=$1,component_role=coalesce($3,component_role),updated_at=now() where id=$2 or production_id=$2`,
    [groupId, productionId, options.role || null])
  return groupId
}

let backfill: Promise<void> | undefined
/**
 * Older installations have applications without a project. Give each its own,
 * keep staging copies with their production app, and drop projects left empty.
 */
export function ensureEveryAppHasProject() {
  return backfill ??= (async () => {
    await ensureApplicationGroupsSchema()
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query(`select pg_advisory_xact_lock(hashtext('manager:project-backfill'))`)
      const orphans = await client.query<{ id: string }>(
        `select id from projects where application_group_id is null and (environment='production' or production_id is null) order by created_at`)
      for (const orphan of orphans.rows) await assignOwnProject(client, orphan.id)
      await client.query(`update projects s set application_group_id=p.application_group_id
        from projects p where s.production_id=p.id and s.application_group_id is distinct from p.application_group_id`)
      await client.query(`delete from application_groups g where not exists (select 1 from projects p where p.application_group_id=g.id)`)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  })().catch(error => { backfill = undefined; throw error })
}

// Called inside the creation transaction as well as the related-applications endpoint.
export async function linkApplicationProjects(client: PoolClient, projectId: string, relatedId: string, role: string, relatedRole?: string) {
  projectIdentifier(projectId); projectIdentifier(relatedId); componentRole(role)
  if (relatedRole !== undefined) componentRole(relatedRole)
  if (projectId === relatedId) throw new ApiError('An application cannot be linked to itself', 400)
  const { rows } = await client.query(`select id,name,environment,application_group_id,component_role from projects where id=any($1::uuid[]) order by id for update`, [[projectId, relatedId]])
  if (rows.length !== 2) throw new ApiError('Related application not found', 404)
  if (rows.some(row => row.environment !== 'production')) throw new ApiError('Link production applications; their staging versions follow automatically', 400)
  const project = rows.find(row => row.id === projectId)!
  const related = rows.find(row => row.id === relatedId)!
  // Every application lives in a project. An application that is alone in its own
  // project may move into another one; a project with other apps is never merged implicitly.
  let previousGroup: string | null = null
  if (project.application_group_id && related.application_group_id && project.application_group_id !== related.application_group_id) {
    const others = await client.query(`select count(*)::int as count from projects where application_group_id=$1 and environment='production' and id<>$2`, [project.application_group_id, projectId])
    if (Number(others.rows[0]?.count) > 0) throw new ApiError('This application already shares a project with other apps. Remove it from that project before moving it', 409)
    previousGroup = project.application_group_id
  }
  let groupId = related.application_group_id || project.application_group_id
  if (!groupId) groupId = (await client.query('insert into application_groups (name) values ($1) returning id', [related.name])).rows[0].id
  await client.query('update projects set application_group_id=$1,component_role=$2,updated_at=now() where id=$3 or production_id=$3', [groupId, role, projectId])
  await client.query('update projects set application_group_id=$1,component_role=$2,updated_at=now() where id=$3 or production_id=$3', [groupId, relatedRole ?? related.component_role, relatedId])
  if (previousGroup) await client.query('delete from application_groups where id=$1 and not exists (select 1 from projects where application_group_id=$1)', [previousGroup])
  return groupId as string
}

export async function relatedApplications(id: string) {
  await ensureApplicationGroupsSchema()
  const { rows } = await query(`select p.id,coalesce(p.production_id,p.id) as production_id,p.application_group_id,p.component_role,g.name as group_name
    from projects p left join application_groups g on g.id=p.application_group_id where p.id=$1`, [id])
  if (!rows[0]) throw new ApiError('Application not found', 404)
  const project = rows[0]
  const members = project.application_group_id ? (await query(`select p.id,p.name,p.component_role,p.environment,p.production_id,p.project_type,p.port,p.url,p.default_branch,
    (select count(*)::int from project_data_services s where s.project_id=p.id) as database_count,
    (select status from deployments d where d.project_id=p.id order by started_at desc limit 1) as deployment_status
    from projects p where application_group_id=$1 order by p.component_role,p.name,p.environment`, [project.application_group_id])).rows : []
  const candidates = (await query(`select id,name,project_type,component_role from projects
    where environment='production' and id<>$1 and ($2::uuid is null or application_group_id is null or application_group_id=$2)
    order by name`, [project.production_id, project.application_group_id])).rows
  return { ...project, members, candidates, ...await stackResources(project.application_group_id) }
}

/** Databases and domains the members of a stack share with each other. */
async function stackResources(groupId: string | null) {
  if (!groupId) return { domains: [], sharedDatabases: [], routes: [] }
  const { ensureDomainRoutesSchema } = await import('@/lib/domain-routes')
  await ensureDomainRoutesSchema()
  const { ensureDataServicesSchema } = await import('@/lib/data-services')
  await ensureDataServicesSchema()
  const [domains, sharedDatabases, routes] = await Promise.all([
    query(`select d.id,d.hostname,d.project_id,d.is_primary from project_domains d join projects p on p.id=d.project_id
      where p.application_group_id=$1 order by d.hostname`, [groupId]),
    query(`select c.id,c.project_id,cp.name as project_name,s.project_id as owner_project_id,sp.name as owner_project_name,c.database_name,dc.provider
      from project_data_services c join projects cp on cp.id=c.project_id
      join project_data_services s on s.id::text=c.options->>'sharedFrom' join projects sp on sp.id=s.project_id
      join data_connections dc on dc.id=c.connection_id
      where cp.application_group_id=$1 order by sp.name,cp.name`, [groupId]),
    query(`select r.id,d.hostname,r.path_prefix,r.strip_prefix,r.project_id,p.name as project_name,d.project_id as domain_project_id
      from project_domain_routes r join project_domains d on d.id=r.domain_id join projects p on p.id=r.project_id
      where p.application_group_id=$1 order by d.hostname,r.path_prefix`, [groupId]),
  ])
  return { domains: domains.rows, sharedDatabases: sharedDatabases.rows, routes: routes.rows }
}

export async function renameApplicationGroup(projectId: string, value: unknown, userId?: string) {
  await ensureApplicationGroupsSchema()
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new ApiError('Stack name must be between 1 and 80 characters', 400)
  const { rows } = await query<{ application_group_id: string | null }>('select application_group_id from projects where id=$1', [projectId])
  if (!rows[0]) throw new ApiError('Application not found', 404)
  if (!rows[0].application_group_id) throw new ApiError('This application is not part of a stack', 400)
  await query('update application_groups set name=$1 where id=$2', [name, rows[0].application_group_id])
  await query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null, 'project.group.rename', 'project:' + projectId, { name }])
}

export async function updateApplicationGroup(id: string, body: { relatedProjectId?: unknown; role?: unknown; relatedRole?: unknown; unlink?: boolean }, userId?: string) {
  await ensureApplicationGroupsSchema()
  const client = await db.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query('select coalesce(production_id,id) as id from projects where id=$1', [id])
    if (!rows[0]) throw new ApiError('Application not found', 404)
    const productionId = rows[0].id
    if (body.unlink) {
      // Leaving a stack must not silently break a sibling's database or domain path.
      const shared = await client.query<{ count: number }>(`select (
          (case when to_regclass('project_data_services') is null then 0 else (select count(*) from project_data_services c
            join project_data_services s on s.id::text=c.options->>'sharedFrom'
            join projects cp on cp.id=c.project_id join projects sp on sp.id=s.project_id
            where (cp.id=$1 or cp.production_id=$1 or sp.id=$1 or sp.production_id=$1)) end) +
          (case when to_regclass('project_domain_routes') is null then 0 else (select count(*) from project_domain_routes r
            join project_domains d on d.id=r.domain_id join projects rp on rp.id=r.project_id join projects dp on dp.id=d.project_id
            where (rp.id=$1 or rp.production_id=$1 or dp.id=$1 or dp.production_id=$1)) end)
        )::int as count`, [productionId])
      if (shared.rows[0].count > 0) throw new ApiError('This application shares a database or domain path with its stack. Remove those first, then leave the stack.', 409)
      const current = await client.query<{ application_group_id: string | null }>('select application_group_id from projects where id=$1', [productionId])
      await assignOwnProject(client, productionId, { role: 'application' })
      const previous = current.rows[0]?.application_group_id
      if (previous) await client.query('delete from application_groups where id=$1 and not exists (select 1 from projects where application_group_id=$1)', [previous])
    } else {
      projectIdentifier(body.relatedProjectId)
      await linkApplicationProjects(client, productionId, body.relatedProjectId, componentRole(body.role), body.relatedRole === undefined ? undefined : componentRole(body.relatedRole))
    }
    await client.query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null,
      body.unlink ? 'project.group.unlink' : 'project.group.link', 'project:' + productionId, { relatedProjectId: body.relatedProjectId || null, role: body.role || null }])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
