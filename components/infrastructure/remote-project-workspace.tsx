'use client'

import { AppToolLinks } from '@/components/app/app-tools'
import { ProviderLogo, type Provider } from '@/components/app/providers'
import { Section } from '@/components/app/section'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { StatusLabel } from '@/components/synergy/status'
import { Button } from '@/components/ui/button'
import { RemoteDeploymentHistory } from './remote-deployment-history'
import { ProjectEnvironmentSwitch, ProjectOverview } from '@/components/workspace/project-overview'
import type { ProjectTab } from '@/components/workspace/project-tabs'
import { projectEnvironment } from '@/lib/application-environments'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remoteProjectHref, remoteRuntimeToolsUnavailable } from '@/lib/remote-workspace'
import { ArrowUpRight, KeyRound, Rocket } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RemoteResources } from './remote-resources'
import { StackPanel } from '@/components/app/stack-panel'
import { DomainsPanel } from '@/components/app/domains-panel'

export function RemoteProjectWorkspace({ server, projectId, apps, jobs, tab, preferredEnvironment, now, canWrite, canDeploy, busy, onDeploy }: {
  server: ManagedServer; projectId: string; apps: RemoteApp[]; jobs: RemoteJob[]; tab: ProjectTab; preferredEnvironment: 'production' | 'staging'; now: number; canWrite: boolean; canDeploy: boolean; busy: boolean; onDeploy: (appId: string) => void
}) {
  const router = useRouter()
  const environment = projectEnvironment(apps.map(app => ({ environment: app.environment_name || 'production' })), preferredEnvironment)
  const visible = apps.filter(app => (app.environment_name || 'production') === environment)
  const history = jobs.filter(job => visible.some(app => app.id === job.app_id))
  const domains = visible.filter(app => !app.hostname.endsWith('.invalid'))
  const databases = visible.filter(app => app.database_config)
  const changeTab = (next: ProjectTab) => router.push(remoteProjectHref(server.id, projectId, next, environment))
  const appLink = (app: RemoteApp, section?: string) => remoteAppHref(server.id, app.id, section)
  const unavailable = { ...(server.metrics?.capabilities?.includes('remote-console-v1')?{}:{logs:remoteRuntimeToolsUnavailable,console:remoteRuntimeToolsUnavailable}), ...(server.metrics?.capabilities?.includes('remote-resources-v1')?{}:{jobs:'Update this server’s agent to enable scheduled jobs and workers.'}) }
  return <>
    {tab==='settings'&&visible[0]&&<StackPanel projectId={visible[0].id} serverId={server.id} environment={environment}/>}
    <ProjectEnvironmentSwitch environments={(['production', 'staging'] as const).filter(value => apps.some(app => (app.environment_name || 'production') === value))} value={environment} onChange={value => router.push(remoteProjectHref(server.id, projectId, tab, value))} />
    {tab === 'overview' && <ProjectOverview onTab={changeTab} unavailable={unavailable}
      domains={<>{domains.map(app => <div key={app.id} className="rounded-lg border border-border px-3 py-2.5 text-sm"><a href={`https://${app.hostname}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate font-medium hover:underline">{app.hostname}<ArrowUpRight className="h-3 w-3 shrink-0" /></a><p className="mt-0.5 truncate text-xs text-muted-foreground">→ {app.name}</p></div>)}{!domains.length && <button type="button" onClick={() => changeTab('domains')} className="w-full rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No domain yet · Add one</button>}</>}
      applications={<>{visible.map(app => <div key={app.id} className="syn-tile flex items-center gap-3 p-3"><Link href={appLink(app)} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open ${app.name}`} /><FrameworkAvatar type={app.project_type} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{app.name}</p><p className="text-xs text-muted-foreground">Application · {app.branch}</p></div>{app.guided_setup && !app.setup_completed_at ? <Button asChild size="sm" variant="outline" className="relative z-10 h-7 text-xs"><Link href={appLink(app, 'setup')}>Finish setup</Link></Button> : history.find(job => job.app_id === app.id) ? <StatusLabel status={history.find(job => job.app_id === app.id)!.status} className="text-xs" /> : <span className="text-xs text-muted-foreground">Not deployed</span>}</div>)}</>}
      databases={<>{databases.map(app => <Link key={app.id} href={appLink(app, 'storage')} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent"><ProviderLogo provider={app.database_config!.provider as Provider} size="sm" /><div className="min-w-0"><p className="truncate font-mono text-xs font-medium">{app.database_config!.database}</p><p className="truncate text-xs text-muted-foreground">Used by {app.name}</p></div></Link>)}{!databases.length && <button type="button" onClick={() => changeTab('storage')} className="w-full rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No database · Add a service</button>}</>} />}
    {tab === 'apps' && <Section title="Apps" description="Each app has its own releases and environment. Open an app to configure its settings, database and domain."><div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{visible.map(app => {
      const active = jobs.some(job => job.app_id === app.id && ['queued', 'running'].includes(job.status)), setup = !!app.guided_setup && !app.setup_completed_at
      return <div key={app.id}><div className="flex flex-wrap items-center gap-4 px-4 py-3.5"><FrameworkAvatar type={app.project_type} size="sm" /><div className="min-w-0 flex-1"><Link href={appLink(app)} className="text-sm font-medium hover:underline">{app.name}</Link><p className="truncate text-xs text-muted-foreground">{app.repo_url.replace(/^https?:\/\//, '')} · {app.branch}</p></div><span className="text-xs text-muted-foreground">{setup ? 'Setup incomplete' : active ? 'Deploying…' : app.live_commit ? 'Deployed' : 'Not deployed'}</span>{setup ? <Button asChild size="sm" variant="outline"><Link href={appLink(app, 'setup')}>Finish setup</Link></Button> : <Button size="sm" variant="outline" disabled={!canDeploy || busy || active || !server.enabled || !server.enrolled_at} onClick={() => onDeploy(app.id)}><Rocket className="mr-1.5 h-3.5 w-3.5" />Deploy</Button>}<Button asChild size="sm" variant="ghost"><Link href={appLink(app)}>Open</Link></Button></div><AppToolLinks appId={app.id} hrefFor={(id, section) => remoteAppHref(server.id, id, section)} unavailable={unavailable} className="px-4 pb-3.5" /></div>
    })}</div></Section>}
    {tab === 'deployments' && <RemoteDeploymentHistory key={projectId} serverId={server.id} groupId={projectId} apps={apps} initial={history} now={now}/>}
    {tab === 'environment' && <Section title="Environment variables" description="Each environment has its own settings and secrets. Open an app to edit its variables."><div className="space-y-3">{visible.map(app => <div key={app.id} className="rounded-lg border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium">{app.name}</p><Button asChild size="sm" variant="outline"><Link href={appLink(app, 'environment')}><KeyRound className="mr-1.5 h-3.5 w-3.5" />{canWrite ? 'Edit variables' : 'View environment'}</Link></Button></div><div className="mt-3 flex flex-wrap gap-1.5">{app.env_names.map(name => <span key={name} className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{name}</span>)}{!app.env_names.length && <p className="text-xs text-muted-foreground">No custom variables configured.</p>}</div></div>)}</div></Section>}
    {tab === 'storage' && <RemoteResources apps={visible} mode="storage" />}
    {tab === 'domains' && <div className="space-y-6">{visible.map(app=><Section key={app.id} title={app.name}><DomainsPanel projectId={app.id} projectName={app.name} port={app.live_commit?app.port:null} environment={app.environment_name||'production'} serverId={server.id} role={canWrite?'admin':canDeploy?'operator':'viewer'}/></Section>)}</div>}
    {tab === 'logs' && <Section title="Logs & console" description="Open the runtime tools for an application in this environment."><div className="flex flex-wrap gap-2">{visible.map(app=><Button key={app.id} variant="outline" asChild><Link href={appLink(app,'logs')}>{app.name}</Link></Button>)}</div></Section>}
    {tab === 'settings' && <Section title="Apps in this project" description="Manage each application's name, repository and build settings."><div className="divide-y divide-border">{visible.map(app => <div key={app.id} className="flex items-center justify-between gap-3 py-3"><span className="text-sm font-medium">{app.name}</span><Button asChild variant="outline" size="sm"><Link href={appLink(app, 'settings')}>{canWrite ? 'Edit settings' : 'View settings'}</Link></Button></div>)}</div></Section>}
  </>
}
