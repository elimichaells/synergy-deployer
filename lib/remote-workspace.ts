import type { DeploymentSummary } from '@/components/synergy/deployment-row'
import type { PipelineStage } from './deployment-stages'
import type { ManagedServer, RemoteApp, RemoteJob } from './managed-server-types'
import type { ProjectCardData } from '@/components/workspace/project-card'

export function remoteProjectHref(serverId: string, projectId: string, tab = 'overview', environment?: string) {
  const params = new URLSearchParams({ view: projectId, tab })
  if (environment === 'production' || environment === 'staging') params.set('environment', environment)
  return `/infrastructure/servers/${serverId}?${params}#applications`
}

/** Build projects only from this host, retaining a staging app if its parent is absent. */
export function remoteProjects(serverId: string, applications: RemoteApp[], jobs: RemoteJob[]): ProjectCardData[] {
  const apps = applications.filter(app => app.server_id === serverId)
  const ids = new Set(apps.map(app => app.id))
  const groupOf=(app:RemoteApp)=>app.application_group_id||(app.production_id&&ids.has(app.production_id)?app.production_id:app.id)
  const groups=[...new Set(apps.map(groupOf))]
  return groups.map(groupId => {
    const members = apps.filter(item => groupOf(item)===groupId),app=members.find(item=>item.id===groupId)||members[0]
    return { id: groupId, name: app.group_name||app.name,
      domains: [...new Set(members.filter(item => !item.hostname.endsWith('.invalid')).map(item => item.hostname))],
      database_count: new Set(members.filter(item => item.database_config).map(item => { const db = item.database_config!; return JSON.stringify([db.provider, db.host.toLowerCase(), db.port, db.database]) })).size,
      apps: members.map(item => ({ id: item.id, name: item.name, project_type: item.project_type || 'node', environment: item.environment_name || 'production', production_id: item.production_id && ids.has(item.production_id) ? item.production_id : null, component_role: item.component_role||'application', setup_required: !!item.guided_setup && !item.setup_completed_at, deployed_at: item.deployed_at,
        deployment_status: jobs.filter(job => job.app_id === item.id && (!job.kind || job.kind === 'deploy')).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.status || null })),
    }
  })
}

export const remoteRuntimeToolsUnavailable = 'Runtime logs and console are not supported by this agent. Deployment logs are available under Deployments.'

/** One row per physical database within a selected server workspace. */
export function remoteDatabases(apps: RemoteApp[]) {
  const rows = new Map<string, { key: string; config: NonNullable<RemoteApp['database_config']>; apps: RemoteApp[] }>()
  for (const app of apps) {
    const config = app.database_config
    if (!config) continue
    const key = JSON.stringify([app.server_id, config.provider, config.host.toLowerCase(), Number(config.port), config.database])
    const row = rows.get(key)
    if (row) row.apps.push(app)
    else rows.set(key, { key, config, apps: [app] })
  }
  return [...rows.values()]
}

export function remoteAppHref(serverId: string, appId: string, tab?: string) {
  if(tab==='jobs')return `/infrastructure/servers/${serverId}?section=automation&project=${appId}#server-access`
  return `/infrastructure/servers/${serverId}${tab ? `?tab=${tab}` : ''}#app-${appId}`
}
export function remoteDeploymentHref(serverId: string, jobId: string) {
  return `/infrastructure/servers/${serverId}?view=${jobId}#deployments`
}
/** Only stages actually implemented by the agent. Never imply a security audit or preflight ran. */
export function remotePipeline(job: RemoteJob): PipelineStage[] {
  const seen = [...job.log.matchAll(/^\[stage\] ([\w-]+)/gm)].map(match => match[1]==='script'?'build':match[1]==='pre-deploy'?'install':match[1]).filter(value=>value!=='post-deploy')
  const definitions = [['checkout', 'Checkout'], ['install', 'Install'], ['build', 'Build'], ['security','Security gate'], ['activate', 'Activate'], ['health', 'Health'], ['caddy', 'HTTPS']] as const
  const last = definitions.findIndex(([key])=>key===seen.at(-1))
  return definitions.map(([key, label], index) => ({ key: key === 'caddy' ? 'routing' : key, label, durationSec: null,
    state: job.status === 'queued' ? 'pending' : job.status === 'cancelled' ? 'skipped'
      : job.status === 'success' ? seen.includes(key) ? 'done' : 'skipped'
      : index === last ? job.status === 'failed' ? 'failed' : 'active'
      : index < last ? seen.includes(key) ? 'done' : 'skipped' : 'pending',
  }))
}
export function remoteDeployment(job: RemoteJob, apps: RemoteApp[]): DeploymentSummary {
  const app = apps.find(item => item.id === job.app_id)
  if (!app) throw new Error('Deployment does not belong to this server workspace')
  return { id: job.id, project_id: app.id, project_name: app.name, status: job.status, branch: job.branch||null,
    commit_sha: job.commit_sha, started_at: job.started_at, finished_at: job.finished_at, log: job.log,
    trigger: job.trigger||'manual', href: remoteDeploymentHref(app.server_id, job.id), stages: remotePipeline(job),
    is_active: job.status === 'success' && !!app.live_commit && job.commit_sha === app.live_commit && job.finished_at === app.deployed_at,
  }
}
export function remoteProcessState(server: ManagedServer, app: RemoteApp, fresh: boolean) {
  const process = server.metrics?.apps.find(item => item.id === app.id)
  return !fresh ? { readiness: 'unknown', label: 'Unknown' }
    : process?.status === 'online' && process.check?.ok===false ? {readiness:'offline',label:'Unhealthy'}
    : process?.status === 'online' ? { readiness: 'ready', label: 'Running' }
    : { readiness: 'offline', label: process?.status || 'Not running' }
}
