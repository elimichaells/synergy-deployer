import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { ensureApplicationGroupsSchema, ensureEveryAppHasProject } from '@/lib/application-groups'

// A project is an application group: the frontend, backend and services that ship
// together, plus the databases and domains they use. Every application has one.

export interface ProjectApp {
  id: string
  name: string
  component_role: string
  environment: 'production' | 'staging'
  project_type: string
  port: number | null
  url: string | null
  is_active: boolean
  production_id: string | null
  setup_required: boolean
  repo_url: string | null
  default_branch: string
  deployment_status: 'queued' | 'running' | 'success' | 'failed' | null
  deployed_at: string | null
}

async function ensureProjectSchemas() {
  await ensureApplicationGroupsSchema()
  await ensureEveryAppHasProject()
  const [{ ensureProjectSetupSchema }, { ensureDataServicesSchema }, { ensureDomainRoutesSchema }, { ensureDeploymentSchema }] = await Promise.all([
    import('@/lib/project-setup'), import('@/lib/data-services'), import('@/lib/domain-routes'), import('@/lib/deployment-schema'),
  ])
  await Promise.all([ensureProjectSetupSchema(), ensureDataServicesSchema(), ensureDomainRoutesSchema(), ensureDeploymentSchema()])
}

const APPS = `coalesce(json_agg(json_build_object(
    'id',p.id,'name',p.name,'component_role',p.component_role,'environment',p.environment,'project_type',p.project_type,
    'port',p.port,'url',p.url,'is_active',p.is_active,'production_id',p.production_id,'repo_url',p.repo_url,'default_branch',p.default_branch,'auto_deploy',p.auto_deploy,
    'setup_required',(ps.project_id is not null and ps.completed_at is null),
    'deployment_status',(select d.status from deployments d where d.project_id=p.id order by d.started_at desc nulls last limit 1),
    'deployed_at',(select coalesce(d.finished_at,d.started_at) from deployments d where d.project_id=p.id order by d.started_at desc nulls last limit 1)
  ) order by case p.component_role when 'frontend' then 0 when 'application' then 1 when 'backend' then 2 else 3 end, p.name, p.environment)
  filter (where p.id is not null), '[]'::json) as apps`

export async function listProjects() {
  await ensureProjectSchemas()
  // Applications removed from Synergy can leave a project behind with nothing in it.
  await query('delete from application_groups g where not exists (select 1 from projects p where p.application_group_id=g.id)')
  const { rows } = await query<{ id: string; name: string; created_at: string; apps: ProjectApp[]; database_count: number; domains: string[] | null }>(
    `select g.id,g.name,g.created_at,${APPS},
       (select count(*)::int from project_data_services s join projects sp on sp.id=s.project_id
         where sp.application_group_id=g.id and coalesce(s.options->>'ownership','manager')<>'shared') as database_count,
       -- Managed domains first, then addresses set by hand as an app's URL.
       (select array_agg(host order by rank, host) from (
          select distinct on (host) host, rank from (
            select d.hostname as host, case when d.is_primary then 0 else 1 end as rank from project_domains d join projects dp on dp.id=d.project_id where dp.application_group_id=g.id
            union all
            select lower(regexp_replace(regexp_replace(dp.url, '^https?://', ''), '[/:].*$', '')), 2 from projects dp
             where dp.application_group_id=g.id and dp.environment='production' and coalesce(dp.url, '') <> ''
          ) hosts order by host, rank) unique_hosts) as domains
     from application_groups g
     left join projects p on p.application_group_id=g.id
     left join project_setup ps on ps.project_id=p.id
     group by g.id order by lower(g.name)`)
  return rows.map(row => ({ ...row, domains: row.domains || [] }))
}

export async function getProject(id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError('Project not found', 404)
  await ensureProjectSchemas()
  const { rows } = await query<{ id: string; name: string; created_at: string; apps: ProjectApp[] }>(
    `select g.id,g.name,g.created_at,${APPS}
       from application_groups g left join projects p on p.application_group_id=g.id left join project_setup ps on ps.project_id=p.id
      where g.id=$1 group by g.id`, [id])
  const project = rows[0]
  if (!project) throw new ApiError('Project not found', 404)
  const appIds = project.apps.map(app => app.id)
  const [domains, routes, databases] = await Promise.all([
    query(`select d.id,d.hostname,d.project_id,d.is_primary,d.dns_status,d.ssl_status,d.cloudflare_connection_id from project_domains d
      where d.project_id=any($1::uuid[]) order by d.is_primary desc,d.hostname`, [appIds]),
    query(`select r.id,r.domain_id,d.hostname,d.project_id as domain_project_id,r.project_id,r.path_prefix,r.strip_prefix
      from project_domain_routes r join project_domains d on d.id=r.domain_id where r.project_id=any($1::uuid[]) or d.project_id=any($1::uuid[])
      order by d.hostname,length(r.path_prefix) desc`, [appIds]),
    query(`select s.id,s.project_id,s.name,s.database_name,s.env_prefix,s.application_primary,s.options,dc.provider,dc.name as connection_name,
        bs.last_status as backup_status,bs.frequency as backup_frequency
      from project_data_services s join data_connections dc on dc.id=s.connection_id
      left join data_service_backup_schedules bs on bs.service_id=s.id
      where s.project_id=any($1::uuid[]) order by s.created_at`, [appIds]),
  ])
  return { ...project, domains: domains.rows, routes: routes.rows, databases: databases.rows }
}

export async function renameProject(id: string, value: unknown) {
  await ensureApplicationGroupsSchema()
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new ApiError('Project name must be between 1 and 80 characters', 400)
  const { rowCount } = await query('update application_groups set name=$1 where id=$2', [name, id])
  if (!rowCount) throw new ApiError('Project not found', 404)
}
