import type { DeploymentSummary } from '@/components/synergy/deployment-row'
import type { PipelineStage } from './deployment-stages'
import type { ManagedServer, RemoteApp, RemoteJob } from './managed-server-types'

export function remoteAppHref(serverId: string, appId: string, tab?: string) {
  return `/infrastructure/servers/${serverId}${tab ? `?tab=${tab}` : ''}#app-${appId}`
}
export function remoteDeploymentHref(serverId: string, jobId: string) {
  return `/infrastructure/servers/${serverId}?view=${jobId}#deployments`
}
/** Only stages actually implemented by the agent. Never imply a security audit or preflight ran. */
export function remotePipeline(job: RemoteJob): PipelineStage[] {
  const definitions = [['checkout', 'Checkout'], ['install', 'Install'], ['build', 'Build'], ['activate', 'Activate'], ['health', 'Health'], ['caddy', 'HTTPS']] as const
  const seen = [...job.log.matchAll(/^\[stage\] (\w+)/gm)].map(match => match[1])
  const last = Math.max(-1, ...seen.map(stage => definitions.findIndex(([key]) => key === stage)))
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
  return { id: job.id, project_id: app.id, project_name: app.name, status: job.status, branch: null,
    commit_sha: job.commit_sha, started_at: job.started_at, finished_at: job.finished_at, log: job.log,
    trigger: 'manual', href: remoteDeploymentHref(app.server_id, job.id), stages: remotePipeline(job),
    is_active: job.status === 'success' && !!app.live_commit && job.commit_sha === app.live_commit && job.finished_at === app.deployed_at,
  }
}
export function remoteProcessState(server: ManagedServer, app: RemoteApp, fresh: boolean) {
  const process = server.metrics?.apps.find(item => item.id === app.id)
  return !fresh ? { readiness: 'unknown', label: 'Unknown' }
    : process?.status === 'online' ? { readiness: 'ready', label: 'Running' }
    : { readiness: 'offline', label: process?.status || 'Not running' }
}
