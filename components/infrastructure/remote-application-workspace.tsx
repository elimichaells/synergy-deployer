'use client'
import {useState} from 'react'
import {PromoteSheet} from '@/components/app/promote-sheet'
import {StoragePanel} from '@/components/app/storage-panel'
import { Section, StatusLine } from '@/components/app/section'
import { ApplicationRemoval } from '@/components/app/application-removal'
import { ApplicationProcess } from '@/components/app/application-process'
import { ApplicationHealth } from '@/components/app/health-settings'
import { EnvironmentSettings } from '@/components/app/environment-settings'
import { GitAutomation } from '@/components/app/git-automation'
import { SecurityGateSetting,SecurityGateBanner,useSecurityGate } from '@/components/app/security-gate'
import { MemorySetting } from '@/components/app/memory-setting'
import { StagingSleepSetting } from '@/components/app/staging-sleep'
import { AppToolLinks } from '@/components/app/app-tools'
import { RuntimeLogs } from '@/components/app/runtime-logs'
import { RuntimeView } from '@/components/app/runtime-view'
import { StackPanel } from '@/components/app/stack-panel'
import { DomainsPanel } from '@/components/app/domains-panel'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { Button } from '@/components/ui/button'
import { ApplicationRelease } from '@/components/workspace/application-release'
import { RemoteDeploymentHistory } from './remote-deployment-history'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remoteProcessState } from '@/lib/remote-workspace'
import { Activity, ArrowRight, Database, Globe2, Rocket } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RemoteAppSetup } from './remote-app-setup'
import { RemoteAppForm } from './remote-app-form'
import { RemoteConsole } from './remote-console'

export function RemoteApplicationWorkspace({ server, app, apps, jobs, tab, now, fresh, admin, deployer, onTab, onChanged, onDirtyChange, onDeploy }: {
  server: ManagedServer; app: RemoteApp; apps: RemoteApp[]; jobs: RemoteJob[]; tab: string; now: number; fresh: boolean; admin: boolean; deployer: boolean
  onTab: (tab: string) => void; onChanged: () => void; onDirtyChange: (dirty: boolean) => void; onDeploy: () => Promise<void>
}) {
  const router=useRouter()
  const [promoteOpen,setPromoteOpen]=useState(false)
  const security=useSecurityGate(app.id,server.id)
  const history = jobs.filter(job => job.app_id === app.id).map(job => remoteDeployment(job, apps))
  const live = history.find(job => job.is_active) || null
  const active = history.some(job => job.status === 'running' || job.status === 'queued')
  const status = remoteProcessState(server, app, fresh), needsSetup = !!app.guided_setup && !app.setup_completed_at
  const url = app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`
  const related = apps.filter(item => item.id !== app.id && (item.production_id || item.id) === (app.production_id || app.id))
  const section = ({environment:'environment',storage:'database',domains:'domain',settings:'runtime'} as const)[tab as 'environment'|'storage'|'domains'|'settings']
  if(tab==='environment')return <EnvironmentSettings projectId={app.id} serverId={server.id} canWrite={deployer} browserApp={app.project_type==='angular'} onDirtyChange={onDirtyChange} onSaved={onChanged}/>
  if(tab==='storage')return <StoragePanel projectId={app.id} projectName={app.name} projectType={app.project_type||'node'} role={admin?'admin':deployer?'operator':'viewer'} onChanged={onChanged}/>
  if(tab==='domains'&&app.live_commit)return <div className="space-y-6"><DomainsPanel projectId={app.id} projectName={app.name} port={app.port} serverId={server.id} environment={app.environment_name||'production'} role={admin?'admin':deployer?'operator':'viewer'} onChanged={onChanged}/><details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Primary address configuration</summary><div className="mt-4">{app.guided_setup?<RemoteAppSetup server={server} appId={app.id} section="domain" canWrite={admin} canDeploy={deployer} onChanged={onChanged} onDirtyChange={onDirtyChange} onDeploy={onDeploy}/>:<RemoteAppForm serverId={server.id} platform={server.platform} app={app} section="domains" canWrite={admin&&server.enabled} onSaved={onChanged} onDirtyChange={onDirtyChange}/>}</div></details></div>
  if(tab==='settings')return <div className="space-y-6">
    <GitAutomation projectId={app.id} serverId={server.id} branch={app.branch} autoDeploy={!!app.auto_deploy} canWrite={admin} onChanged={onChanged}/>
    <ApplicationHealth key={app.id} id={app.id} serverId={server.id} canWrite={deployer&&server.enabled&&!active&&(!app.live_commit||fresh&&server.metrics?.capabilities?.includes('application-control-v1')===true)}/>
    <Section title="Dependency security gate" description="Checks production dependencies before they go live."><SecurityGateSetting loadError={security.loadError} onRetry={security.reload} projectId={app.id} appName={app.name} serverId={server.id} gate={security.gate} canTurnOff={security.canTurnOff} canWrite={deployer} onChanged={security.setGate}/></Section>
    {app.guided_setup?<RemoteAppSetup key={`${app.id}:settings`} server={server} appId={app.id} section="runtime" canWrite={admin} canDeploy={deployer} onChanged={onChanged} onDirtyChange={onDirtyChange} onDeploy={onDeploy}/>:<RemoteAppForm key={`${app.id}:settings`} serverId={server.id} platform={server.platform} app={app} section="settings" canWrite={admin&&server.enabled} onSaved={onChanged} onDirtyChange={onDirtyChange}/>}
    {app.environment_name==='staging'&&<Section id="sleep" title="Sleep when idle" description="Stop this staging app when nobody has used it for a while, to give its memory back to the server."><StagingSleepSetting projectId={app.id} serverId={server.id} canWrite={deployer&&fresh&&!!app.live_commit&&!active}/></Section>}
    <Section id="memory" title="Memory" description="How much memory this app uses, and a limit so a leak cannot starve the whole server."><MemorySetting projectId={app.id} serverId={server.id} canWrite={deployer&&fresh&&!!app.live_commit&&!active&&server.metrics?.capabilities?.includes('application-control-v1')===true}/>{!server.metrics?.capabilities?.includes('application-control-v1')&&<p className="mt-3 text-sm text-muted-foreground">Update the agent in Agent access & updates to save memory limits without restarting.</p>}</Section>
    <Section title="Server" description="Where this application runs on the selected server."><p className="mb-4 text-sm text-muted-foreground">{server.name} · port {app.port}</p><ApplicationProcess appId={app.id} name={app.name} serverId={server.id} canWrite={deployer&&fresh&&!!app.live_commit&&!active&&server.metrics?.capabilities?.includes('remote-infrastructure-v1')===true} onChanged={onChanged}/></Section>
    {admin&&<ApplicationRemoval appId={app.id} name={app.name} serverId={server.id} onRemoved={()=>{router.push(`/infrastructure/servers/${server.id}#applications`);onChanged()}}/>}
  </div>
  if (tab === 'setup' || section) {
    if (app.guided_setup) return <RemoteAppSetup key={`${app.id}:${tab}`} server={server} appId={app.id} section={section} canWrite={admin} canDeploy={deployer} onChanged={onChanged} onDirtyChange={onDirtyChange} onDeploy={onDeploy} />
    if (tab === 'storage') return <Section title="Databases" description="This application uses connection variables to reach its database."><p className="text-sm text-muted-foreground">Manage its database address and credentials in Environment. Database provisioning requires an application imported with guided setup.</p><Button className="mt-4" variant="outline" onClick={() => onTab('environment')}>Open environment</Button></Section>
    return <RemoteAppForm key={`${app.id}:${tab}`} serverId={server.id} platform={server.platform} app={app} section={tab === 'environment' || tab === 'domains' ? tab : 'settings'} canWrite={admin && server.enabled} onSaved={onChanged} onDirtyChange={onDirtyChange} />
  }
  if (tab === 'deployments') return <RemoteDeploymentHistory key={app.id} serverId={server.id} appId={app.id} apps={apps} initial={jobs} now={now}/>
  if(tab==='logs'||tab==='console')return <div><RuntimeView active={tab} onChange={onTab}/>{tab==='logs'?<RuntimeLogs projectId={app.id} serverId={server.id} canWrite={deployer} unavailable={!server.metrics?.capabilities?.includes('application-control-v1')?'Update the agent to enable application log streams.':!fresh?'Reconnect this server to read current logs.':!app.live_commit?'Deploy this application to create its runtime logs.':undefined}/>:<RemoteConsole server={server} appId={app.id} admin={deployer}/>}</div>
  return <div className="space-y-6">
    <SecurityGateBanner projectId={app.id} serverId={server.id} gate={security.gate} canWrite={deployer} onChanged={security.setGate}/>
    <AppToolLinks appId={app.id} hrefFor={(id,section)=>remoteAppHref(server.id,id,section)}/>
    <StackPanel projectId={app.id} serverId={server.id} environment={app.environment_name||'production'} onChanged={onChanged}/>
    {!!related.length && <div className="flex flex-wrap gap-2">{related.map(item => <Button key={item.id} variant="outline" size="sm" asChild><Link href={remoteAppHref(server.id,item.id)}>Open {item.environment_name}</Link></Button>)}</div>}
    {needsSetup ? <div className="relative overflow-hidden rounded-xl border border-border bg-well p-8"><div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" /><div className="relative flex flex-wrap items-center justify-between gap-6"><div className="flex items-center gap-4"><FrameworkAvatar type={app.project_type} size="lg" /><div><p className="text-xl font-semibold tracking-tight">Finish setting up {app.name}</p><p className="mt-1 text-sm text-muted-foreground">A few more steps (database, environment and domain), then your first deployment.</p></div></div><Button onClick={() => onTab('setup')}>Continue setup<ArrowRight className="ml-1.5 h-4 w-4" /></Button></div></div>
      : <ApplicationRelease project={{project_type:app.project_type || 'node',default_branch:app.branch,repo_url:app.repo_url}} live={live} unlistedRelease={!live && app.live_commit ? {commit:app.live_commit,releasedAt:app.deployed_at} : undefined} primaryUrl={url} address={url ? app.hostname : null} hasRunningDeploy={active} clock={now} runtimeLogs={server.metrics?.capabilities?.includes('remote-console-v1')===true} changeTab={onTab}
        statusLabel={active ? 'Deploying…' : !app.live_commit ? 'Not deployed yet' : status.label}
        statusHint={active ? 'Building on this server. Activation is followed by a health check and automatic recovery on failure.' : !app.live_commit ? 'Deploy to put the first release live.' : fresh ? server.metrics?.apps.find(item=>item.id===app.id)?.check ? `The agent checks this application’s process and HTTP readiness continuously. Current status: ${status.label.toLowerCase()}.` : `Agent process status: ${status.label.toLowerCase()}. No current HTTP readiness result is available.` : 'Fresh process status is unavailable. Check this server’s Infrastructure page.'} />}
    <Section title="At a glance" description="How this application is running, in plain language."><div className="divide-y divide-border">
      <StatusLine tone={status.readiness === 'ready' ? 'ok' : 'off'} icon={<Activity className="h-3.5 w-3.5" />}><span className="font-medium">{status.label}</span><span className="text-muted-foreground"> — port {app.port} · health check {app.health_path}</span></StatusLine>
      <StatusLine tone={url ? 'ok' : 'warn'} icon={<Globe2 className="h-3.5 w-3.5" />} action={<Button variant="ghost" size="sm" onClick={() => onTab('domains')}>Manage</Button>}><span className="font-medium">{url ? app.hostname : 'No domain configured'}</span><span className="text-muted-foreground"> · {app.access_mode.toUpperCase()} HTTPS</span></StatusLine>
      <StatusLine tone={app.database_config?.status === 'ready' ? 'ok' : 'off'} icon={<Database className="h-3.5 w-3.5" />} action={<Button variant="ghost" size="sm" onClick={() => onTab('storage')}>{app.database_config ? 'Manage' : 'Add database'}</Button>}><span className="font-medium">{app.database_config?.database || 'No managed database connection'}</span>{app.database_config && <span className="text-muted-foreground"> · {app.database_config.provider} · {app.database_config.status}</span>}</StatusLine>
      <StatusLine tone={app.auto_deploy?'ok':'off'} icon={<Rocket className="h-3.5 w-3.5" />}><span className="font-medium">{app.auto_deploy?'Deploy on push':'Manual deploys'}</span><span className="text-muted-foreground"> from branch {app.branch}</span></StatusLine>
    </div></Section>
  </div>
}
