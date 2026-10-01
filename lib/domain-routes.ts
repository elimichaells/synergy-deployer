import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { updateCaddyStrict } from '@/lib/caddy'
import { ensureCloudflareSchema } from '@/lib/cloudflare'
import { normalizeRoutePrefix, orderRoutes, stackRouteProblem } from '@/lib/domain-route-policy'

export interface DomainRoute {
  id: string
  domain_id: string
  hostname: string
  domain_project_id: string
  domain_project_name: string
  project_id: string
  project_name: string
  component_role: string
  path_prefix: string
  strip_prefix: boolean
  created_at: string
}

let schema: Promise<void> | undefined
export function ensureDomainRoutesSchema() {
  return schema ??= ensureCloudflareSchema().then(() => query(`
    create table if not exists project_domain_routes (
      id uuid primary key default gen_random_uuid(),
      domain_id uuid not null references project_domains(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      path_prefix text not null,
      strip_prefix boolean not null default false,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      unique (domain_id, path_prefix)
    );
    create index if not exists project_domain_routes_project_idx on project_domain_routes (project_id);
  `)).then(() => {}).catch(error => { schema = undefined; throw error })
}

/** Routes on this application's domains, and routes that send traffic to this application. */
export async function listDomainRoutes(projectId?: string) {
  await ensureDomainRoutesSchema()
  const { rows } = await query<DomainRoute>(
    `select r.id,r.domain_id,d.hostname,d.project_id as domain_project_id,dp.name as domain_project_name,
            r.project_id,p.name as project_name,p.component_role,r.path_prefix,r.strip_prefix,r.created_at
       from project_domain_routes r
       join project_domains d on d.id=r.domain_id
       join projects dp on dp.id=d.project_id
       join projects p on p.id=r.project_id
      ${projectId ? 'where r.project_id=$1 or d.project_id=$1' : ''}
      order by d.hostname`, projectId ? [projectId] : [])
  return orderRoutes(rows)
}

async function reloadDomain(domainId: string) {
  const { rows } = await query<{ hostname: string; port: number | null }>(
    'select d.hostname,p.port from project_domains d join projects p on p.id=d.project_id where d.id=$1', [domainId])
  if (!rows[0]) throw new ApiError('Domain not found', 404)
  if (!rows[0].port) throw new ApiError('The application that owns this domain has no port', 400)
  await updateCaddyStrict(rows[0].hostname, rows[0].port)
}

export async function createDomainRoute(input: Record<string, unknown>, createdBy?: string | null) {
  await ensureDomainRoutesSchema()
  let pathPrefix: string
  try { pathPrefix = normalizeRoutePrefix(input.pathPrefix) } catch (error) { throw new ApiError((error as Error).message, 400) }
  const domainId = String(input.domainId || '')
  const targetId = String(input.projectId || '')
  const { rows } = await query<{ domain_project_id: string; domain_group: string | null; domain_env: string; target_group: string | null; target_env: string; target_port: number | null }>(
    `select d.project_id as domain_project_id,dp.application_group_id as domain_group,dp.environment as domain_env,
            t.application_group_id as target_group,t.environment as target_env,t.port as target_port
       from project_domains d join projects dp on dp.id=d.project_id, projects t
      where d.id::text=$1 and t.id::text=$2`, [domainId, targetId])
  const facts = rows[0]
  if (!facts) throw new ApiError('Domain or application not found', 404)
  const problem = stackRouteProblem({ domainProjectId: facts.domain_project_id, domainGroupId: facts.domain_group, domainEnvironment: facts.domain_env,
    targetProjectId: targetId, targetGroupId: facts.target_group, targetEnvironment: facts.target_env, targetPort: facts.target_port })
  if (problem) throw new ApiError(problem, 400)
  let id: string
  try {
    const inserted = await query<{ id: string }>(
      'insert into project_domain_routes (domain_id,project_id,path_prefix,strip_prefix,created_by) values ($1,$2,$3,$4,$5) returning id',
      [domainId, targetId, pathPrefix, input.stripPrefix === true, createdBy || null])
    id = inserted.rows[0].id
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ApiError(`${pathPrefix} is already routed on this domain`, 409)
    throw error
  }
  try {
    await reloadDomain(domainId)
  } catch (error) {
    // Caddy rejected the configuration; keep the database consistent with what is served.
    await query('delete from project_domain_routes where id=$1', [id])
    throw error
  }
  return (await listDomainRoutes(targetId)).find(route => route.id === id)
}

export async function deleteDomainRoute(id: string) {
  await ensureDomainRoutesSchema()
  const { rows } = await query<{ domain_id: string; project_id: string; path_prefix: string; strip_prefix: boolean; created_by: string | null }>(
    'delete from project_domain_routes where id=$1 returning domain_id,project_id,path_prefix,strip_prefix,created_by', [id])
  const route = rows[0]
  if (!route) throw new ApiError('Route not found', 404)
  try {
    await reloadDomain(route.domain_id)
  } catch (error) {
    await query('insert into project_domain_routes (id,domain_id,project_id,path_prefix,strip_prefix,created_by) values ($1,$2,$3,$4,$5,$6)',
      [id, route.domain_id, route.project_id, route.path_prefix, route.strip_prefix, route.created_by])
    throw error
  }
  return route
}
