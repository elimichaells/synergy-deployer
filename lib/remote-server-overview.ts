import type { ManagedServer, RemoteApp, RemoteJob } from './managed-server-types'

export function remoteWorkspaceView(hash: string): 'overview' | 'applications' | 'deployments' | 'server-access' | 'app' | 'new' | 'storage' | 'domains' {
  if (/^#app-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(hash)) return 'app'
  if (['#applications', '#deployments', '#server-access', '#new', '#storage', '#domains'].includes(hash)) return hash.slice(1) as 'applications' | 'deployments' | 'server-access' | 'new' | 'storage' | 'domains'
  return 'overview'
}

export function remoteOverview(server: ManagedServer, applications: RemoteApp[], history: RemoteJob[], now: number, loadError = false) {
  const apps = applications.filter(app => app.server_id === server.id)
  const ids = new Set(apps.map(app => app.id))
  const jobs = history.filter(job => ids.has(job.app_id) && (!job.kind || job.kind === 'deploy')).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const latest = new Map<string, RemoteJob>()
  for (const job of jobs) if (!latest.has(job.app_id)) latest.set(job.app_id, job)
  const seen = Date.parse(server.last_seen_at || '')
  const fresh = !loadError && server.enabled && server.status === 'online' && !!server.metrics && Number.isFinite(seen) && now - seen <= 90_000
  const completed = jobs.filter(job => job.status === 'success' || job.status === 'failed')
  return {
    apps, jobs, fresh,
    running: fresh ? server.metrics!.apps.filter(app => ids.has(app.id) && app.status === 'online').length : null,
    active: jobs.filter(job => job.status === 'queued' || job.status === 'running'),
    successRate: completed.length ? Math.round(completed.filter(job => job.status === 'success').length / completed.length * 100) : null,
    failed: [...latest.values()].filter(job => job.status === 'failed').length,
    lastRelease: jobs.find(job => job.status === 'success'),
  }
}
