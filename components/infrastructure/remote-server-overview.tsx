import { ServerOverviewContent } from '@/components/workspace/server-overview'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteOverview } from '@/lib/remote-server-overview'
import { remoteAppHref, remoteDeployment, remoteProcessState } from '@/lib/remote-workspace'
import { Globe2, Plus, Server } from 'lucide-react'

export function RemoteServerOverview({ server, apps, jobs, now, loadError, canCreate }: {
  server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; now: number; loadError: boolean; canCreate: boolean
}) {
  const summary = remoteOverview(server, apps, jobs, now, loadError)
  const root = `/infrastructure/servers/${server.id}`
  return <ServerOverviewContent now={now} projectsHref={`${root}#applications`} deploymentsHref={`${root}#deployments`}
    projects={summary.apps.map(app => ({ id: app.id, name: app.name, project_type: app.project_type || 'node', environment: app.environment_name || 'production',
      url: app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`, port: app.port, href: remoteAppHref(server.id, app.id),
      setup_required: !!app.guided_setup && !app.setup_completed_at, readiness: remoteProcessState(server, app, summary.fresh).readiness,
      statusLabel: remoteProcessState(server, app, summary.fresh).label }))}
    deployments={summary.jobs.map(job => remoteDeployment(job, summary.apps))}
    healthHint={summary.running === null ? 'Health unknown' : `${summary.running} ${summary.running === 1 ? 'process' : 'processes'} running`}
    historyNote="Statistics use the latest 30 deployment records on this server. Process status comes from its agent; HTTP readiness is checked during deployment."
    shortcuts={[
      ...(canCreate ? [{ href: `${root}#new`, icon: Plus, title: 'Import a repository', hint: 'Build, verify and serve a new app' }] : []),
      { href: `${root}#domains`, icon: Globe2, title: 'Connect a domain', hint: 'Readable addresses and automatic TLS' },
      { href: `${root}#server-access`, icon: Server, title: 'Server health & access', hint: 'Processes, runtimes and agent updates' },
    ]} />
}
