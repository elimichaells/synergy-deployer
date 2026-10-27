'use client'
import { Section, StatusLine } from '@/components/app/section'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { Button } from '@/components/ui/button'
import { ApplicationRelease } from '@/components/workspace/application-release'
import { DeploymentHistory } from '@/components/workspace/deployment-history'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remoteProcessState } from '@/lib/remote-workspace'
import { Activity, ArrowRight, Database, Globe2, Rocket } from 'lucide-react'
import Link from 'next/link'
import { RemoteAppSetup } from './remote-app-setup'

export function RemoteApplicationWorkspace({ server, app, apps, jobs, tab, now, fresh, admin, deployer, onTab, onChanged, onDirtyChange, onDeploy, onEdit }: {
  server: ManagedServer; app: RemoteApp; apps: RemoteApp[]; jobs: RemoteJob[]; tab: string; now: number; fresh: boolean; admin: boolean; deployer: boolean
  onTab: (tab: string) => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void; onDeploy: () => Promise<void>; onEdit: () => void
}) {
  const history = jobs.filter(job => job.app_id === app.id).map(job => remoteDeployment(job, apps))
  const live = history.find(job => job.is_active) || null
  const active = history.some(job => job.status === 'running' || job.status === 'queued')
  const status = remoteProcessState(server, app, fresh), needsSetup = !!app.guided_setup && !app.setup_completed_at
  const url = app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`
  const related = apps.filter(item => item.id !== app.id && (item.production_id || item.id) === (app.production_id || app.id))
  const section = ({environment:'environment',storage:'database',domains:'domain',settings:'runtime'} as const)[tab as 'environment'|'storage'|'domains'|'settings']
  if (tab === 'setup' || section) return app.guided_setup ? <RemoteAppSetup key={`${app.id}:${tab}`} server={server} appId={app.id} section={section} canWrite={admin} canDeploy={deployer} onChanged={onChanged} onDirtyChange={onDirtyChange} onDeploy={onDeploy} /> : <Section title={tab === 'storage' ? 'Databases' : 'Application settings'} description="This application was created with the earlier configuration form."><p className="text-sm text-muted-foreground">Its existing configuration is preserved. Use Edit settings to manage its commands, environment variables and hostname.</p>{admin && server.enabled && <Button className="mt-4" variant="outline" onClick={onEdit}>Edit settings</Button>}</Section>
  if (tab === 'deployments') return <DeploymentHistory deployments={history} now={now} projectsHref={`/infrastructure/servers/${server.id}#applications`} />
  if (tab === 'logs' || tab === 'console') return <Section title="Logs & console" description="Runtime tools for this application."><p className="text-sm leading-6 text-muted-foreground">This agent currently reports deployment logs and process health. Streaming runtime logs and interactive commands are not available through it yet.</p><Button className="mt-4" variant="outline" onClick={() => onTab('deployments')}>View deployment logs</Button></Section>
  return <div className="space-y-6">
    {!!related.length && <div className="flex flex-wrap gap-2">{related.map(item => <Button key={item.id} variant="outline" size="sm" asChild><Link href={remoteAppHref(server.id,item.id)}>Open {item.environment_name}</Link></Button>)}</div>}
    {needsSetup ? <div className="relative overflow-hidden rounded-xl border border-border bg-well p-8"><div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" /><div className="relative flex flex-wrap items-center justify-between gap-6"><div className="flex items-center gap-4"><FrameworkAvatar type={app.project_type} size="lg" /><div><p className="text-xl font-semibold tracking-tight">Finish setting up {app.name}</p><p className="mt-1 text-sm text-muted-foreground">A few more steps (database, environment and domain), then your first deployment.</p></div></div><Button onClick={() => onTab('setup')}>Continue setup<ArrowRight className="ml-1.5 h-4 w-4" /></Button></div></div>
      : <ApplicationRelease project={{project_type:app.project_type || 'node',default_branch:app.branch,repo_url:app.repo_url}} live={live} unlistedRelease={!live && app.live_commit ? {commit:app.live_commit,releasedAt:app.deployed_at} : undefined} primaryUrl={url} address={url ? app.hostname : null} hasRunningDeploy={active} clock={now} runtimeLogs={false} changeTab={onTab}
        statusLabel={active ? 'Deploying…' : !app.live_commit ? 'Not deployed yet' : status.label}
        statusHint={active ? 'Building on this server. Activation is followed by a health check and automatic recovery on failure.' : !app.live_commit ? 'Deploy to put the first release live.' : fresh ? `Agent process status: ${status.label.toLowerCase()}. HTTP readiness is checked at deployment time.` : 'Fresh process status is unavailable. Check this server’s Infrastructure page.'} />}
    <Section title="At a glance" description="How this application is running, in plain language."><div className="divide-y divide-border">
      <StatusLine tone={status.readiness === 'ready' ? 'ok' : 'off'} icon={<Activity className="h-3.5 w-3.5" />}><span className="font-medium">{status.label}</span><span className="text-muted-foreground"> — port {app.port} · health check {app.health_path}</span></StatusLine>
      <StatusLine tone={url ? 'ok' : 'warn'} icon={<Globe2 className="h-3.5 w-3.5" />} action={<Button variant="ghost" size="sm" onClick={() => onTab('domains')}>Manage</Button>}><span className="font-medium">{url ? app.hostname : 'No domain configured'}</span><span className="text-muted-foreground"> · {app.access_mode.toUpperCase()} HTTPS</span></StatusLine>
      <StatusLine tone={app.database_config?.status === 'ready' ? 'ok' : 'off'} icon={<Database className="h-3.5 w-3.5" />} action={<Button variant="ghost" size="sm" onClick={() => onTab('storage')}>{app.database_config ? 'Manage' : 'Add database'}</Button>}><span className="font-medium">{app.database_config?.database || 'No managed database connection'}</span>{app.database_config && <span className="text-muted-foreground"> · {app.database_config.provider} · {app.database_config.status}</span>}</StatusLine>
      <StatusLine tone="off" icon={<Rocket className="h-3.5 w-3.5" />}><span className="font-medium">Manual deploys</span><span className="text-muted-foreground"> from branch {app.branch}</span></StatusLine>
    </div></Section>
  </div>
}
