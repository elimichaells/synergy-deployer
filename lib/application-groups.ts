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
  if (project.application_group_id && related.application_group_id && project.application_group_id !== related.application_group_id) {
    throw new ApiError('These applications belong to different groups. Unlink the application before moving it', 409)
  }
  let groupId = project.application_group_id || related.application_group_id
  if (!groupId) groupId = (await client.query('insert into application_groups (name) values ($1) returning id', [related.name])).rows[0].id
  await client.query('update projects set application_group_id=$1,component_role=$2,updated_at=now() where id=$3 or production_id=$3', [groupId, role, projectId])
  await client.query('update projects set application_group_id=$1,component_role=$2,updated_at=now() where id=$3 or production_id=$3', [groupId, relatedRole ?? related.component_role, relatedId])
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
  return { ...project, members, candidates }
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
      await client.query('update projects set application_group_id=null,updated_at=now() where id=$1 or production_id=$1', [productionId])
    } else {
      projectIdentifier(body.relatedProjectId)
      await linkApplicationProjects(client, productionId, body.relatedProjectId, componentRole(body.role), body.relatedRole === undefined ? undefined : componentRole(body.relatedRole))
    }
    await client.query('insert into audit_logs (user_id,action,resource,details) values ($1,$2,$3,$4)', [userId || null,
      body.unlink ? 'project.group.unlink' : 'project.group.link', 'project:' + productionId, { relatedProjectId: body.relatedProjectId || null, role: body.role || null }])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
