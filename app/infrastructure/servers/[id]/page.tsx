'use client'

import { AgentUpdates } from '@/components/infrastructure/agent-updates'
import { RemoteAppForm } from '@/components/infrastructure/remote-app-form'
import { RemoteAppImport } from '@/components/infrastructure/remote-app-import'
import { RemoteApplicationWorkspace } from '@/components/infrastructure/remote-application-workspace'
import { RemoteApplications } from '@/components/infrastructure/remote-applications'
import { RemoteDeployment } from '@/components/infrastructure/remote-deployment'
import { RemoteResources } from '@/components/infrastructure/remote-resources'
import { RemoteServerOverview } from '@/components/infrastructure/remote-server-overview'
import { ServerEnrollment } from '@/components/infrastructure/server-enrollment'
import { ServerSshSetup } from '@/components/infrastructure/server-ssh-setup'
import { AppShell } from '@/components/layout/app-shell'
import { useWorkspace } from '@/components/layout/workspace-provider'
import { workspaceInfrastructureItems } from '@/components/synergy/nav'
import { EnvironmentBadge } from '@/components/synergy/status'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { ApplicationTabs } from '@/components/workspace/application-tabs'
import { DeploymentHistory } from '@/components/workspace/deployment-history'
import { InfrastructureOverview } from '@/components/workspace/infrastructure-overview'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteOverview, remoteWorkspaceView } from '@/lib/remote-server-overview'
import { remoteAppHref, remoteDeployment } from '@/lib/remote-workspace'
import { ArrowUpRight, Download, Plus, RefreshCw, Rocket } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
type Detail = { server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; role: string }

export default function ManagedServerPage() {
  const { id } = useParams<{ id: string }>()
  return <ManagedServerWorkspace key={id} id={id} />
}

function ManagedServerWorkspace({ id }: { id: string }) {
  const router = useRouter()
  const { navigate } = useWorkspace()
  const params = useSearchParams()
  const [hash, setHash] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [formDirty, setFormDirty] = useState(false)
  const root = `/infrastructure/servers/${id}`
  const view = remoteWorkspaceView(hash)
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<RemoteApp | 'new' | null>(null)
  const [enrollment, setEnrollment] = useState<string | null>(null)
  const [revoke, setRevoke] = useState(false)
  const [manual, setManual] = useState(false)
  const [sshBusy, setSshBusy] = useState(false)
  const [sshSession, setSshSession] = useState(false)
  const load = useCallback(async () => {
    setNow(Date.now())
    try {
      const response = await fetch(`/api/servers/${id}`, { cache: 'no-store' }); const result = await response.json()
      if (!response.ok || !result.server || result.server.id !== id) throw new Error(result.error || 'Could not load server')
      setData(result); setLoadError('')
    } catch (err) { setLoadError((err as Error).message) }
  }, [id])
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10000); return () => clearInterval(timer) }, [load])
  useEffect(() => { setEditing(null); setFormDirty(false); setRevoke(false) }, [hash])
  async function action(suffix: string, body: object = {}) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/servers/${id}${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Action failed')
      if (result.enrollmentToken) setEnrollment(result.enrollmentToken)
      await load(); setRevoke(false)
      return true
    } catch (err) { setError((err as Error).message); return false } finally { setBusy(false) }
  }
  const server = data?.server, metrics = server?.metrics, admin = data?.role === 'admin', deployer = admin || data?.role === 'operator'
  if (!server) return <AppShell title={loadError ? 'Server unavailable' : 'Opening server…'} subtitle={loadError ? 'Choose another server or retry the connection.' : 'Loading this server’s workspace.'} back={{ href: '/', label: 'All servers' }}>
    {loadError ? <div role="alert" className="notice-error"><p>{loadError}</p><Button variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button></div> : <p role="status" className="text-sm text-muted-foreground">Loading server…</p>}
  </AppShell>
  const summary = remoteOverview(server, data?.apps || [], data?.jobs || [], now, !!loadError)
  const selected = view === 'app' ? summary.apps.find(app => hash === `#app-${app.id}`) : undefined
  const openedJob = view === 'deployments' && params.get('view') ? summary.jobs.find(job => job.id === params.get('view')) : undefined
  const infraSection = params.get('section') || 'overview'
  const requestedTab = params.get('tab')
  const appTab = (requestedTab && ['overview','deployments','environment','logs','console','storage','domains','settings','setup'].includes(requestedTab) ? requestedTab : null) || (selected?.guided_setup && !selected.setup_completed_at ? 'setup' : 'overview')
  const changeTab = (tab: string) => { if (selected) navigate(() => router.push(remoteAppHref(id, selected.id, tab))) }
  const titles = { overview: 'Overview', applications: 'Projects', deployments: openedJob ? openedJob.app_name : 'Deployments', 'server-access': 'Infrastructure', storage: 'Storage', domains: 'Domains & HTTPS', new: 'Add a new app', app: selected?.name || 'Application unavailable' }
  const title = editing ? editing === 'new' ? 'New application' : `Edit ${editing.name}` : titles[view]
  const notice = 'rounded-lg border border-status-building/25 bg-status-building/5 p-4 text-sm leading-6 text-status-building'
  return <Tabs value={appTab} onValueChange={changeTab}><AppShell infrastructureSection={params.get('section')} area={view === 'server-access' || view === 'domains' ? 'infrastructure' : undefined} title={title} onWorkspaceHashChange={setHash} unsavedChanges={formDirty} workspace={{ href: `${root}${params.size ? `?${params}` : ''}${hash}`, environment: selected ? selected.environment_name || 'production' : undefined, page: openedJob ? `Release ${openedJob.id.slice(0,8)}` : undefined, destinations: Object.fromEntries(summary.apps.map(app => [`#app-${app.id}`, `${app.name}${app.environment_name ? ` · ${app.environment_name}` : ''}`])) }} subtitle={selected ? <span className="flex items-center gap-2"><EnvironmentBadge environment={selected.environment_name || 'production'} /><span className="font-mono text-xs">{selected.repo_url.replace(/^https?:\/\//, '').replace(/\.git$/, '')}</span></span> : `${server.name} · ${server.platform === 'win32' ? 'Windows' : 'Linux'}${server.location ? ` · ${server.location}` : ''}`}
    back={view === 'app' || view === 'new' ? { href: `${root}#applications`, label: 'Projects' } : openedJob ? { href: `${root}#deployments`, label: 'Deployments' } : undefined}
    tabs={selected && !editing ? <ApplicationTabs activeTab={appTab} showSetupTab={!!selected.guided_setup && (!selected.setup_completed_at || appTab === 'setup')} /> : undefined}
    actions={<>
      {selected && !selected.hostname.endsWith('.invalid') && <Button asChild variant="outline" size="sm"><a href={`https://${selected.hostname}`} target="_blank" rel="noreferrer">Visit<ArrowUpRight className="ml-1.5 h-3.5 w-3.5" /></a></Button>}
      <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button>
      {selected && deployer && <Button size="sm" disabled={busy || !server.enabled || !server.enrolled_at || summary.active.some(job => job.app_id === selected.id) || (!!selected.guided_setup && !selected.setup_completed_at)} onClick={() => void action(`/apps/${selected.id}/deploy`)}><Rocket className="mr-1.5 h-3.5 w-3.5" />Deploy</Button>}
      {admin && server.enabled && !selected && view !== 'new' && !openedJob && !editing && <Button asChild size="sm" disabled={sshBusy}><Link href={`${root}#new`}><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>}
    </>}>
    <div className="space-y-6">
      {(error || loadError) && <p role="alert" className="notice-error">{error || loadError}</p>}
      {(server.status === 'pending' || sshSession) && admin && <>
        {server.status === 'pending' && <div className="flex flex-wrap gap-2"><Button disabled={sshBusy} variant={manual ? 'outline' : 'default'} onClick={() => { setManual(false); setEnrollment(null) }}>Connect with SSH</Button><Button disabled={sshBusy} variant={manual ? 'default' : 'outline'} onClick={() => { setManual(true); setSshSession(false) }}>Install agent manually</Button></div>}
        {!manual ? <ServerSshSetup serverId={id} platform={server.platform} onConnected={() => void load()} onBusyChange={value => { setSshBusy(value); if (value) setSshSession(true) }} /> : <div className="rounded-xl border border-border p-5"><h2 className="font-semibold">Install the agent manually</h2><p className="mt-2 text-sm text-muted-foreground">Use this when SSH is unavailable or the server cannot receive an inbound connection from Manager.</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => void action('', { action: 'enrollment' })}>Create enrollment instructions</Button></div>}
        {server.enrolled_at && !sshBusy && <Button variant="outline" onClick={() => setSshSession(false)}>Close setup</Button>}
      </>}
      {enrollment && server && <ServerEnrollment id={id} token={enrollment} platform={server.platform} onDismiss={() => setEnrollment(null)} />}
      {server.status === 'offline' && <p className={notice}>No heartbeat for more than 90 seconds. These are last reported values. New deployments wait in the queue; a running deployment is never automatically replayed.</p>}
      {server.status === 'online' && !summary.fresh && <p className={notice}>Current server health is unavailable. Last reported values are shown until the next successful heartbeat.</p>}
      {metrics?.proxyError && <p role="alert" className={notice}>Caddy needs attention: {metrics.proxyError}</p>}
      {server?.status === 'revoked' && <p className="rounded-lg border border-border p-4 text-sm">Agent access has been revoked. Existing apps may still be running on the server. Inspect and manage them locally.</p>}
      {!editing && view === 'server-access' && infraSection === 'overview' && <InfrastructureOverview projectsHref={`${root}#applications`} items={workspaceInfrastructureItems(root)} />}
      {!editing && view === 'server-access' && ['health','runtimes'].includes(infraSection) && metrics && <>
        <div className="grid gap-3 sm:grid-cols-3">{[['CPU',`${metrics.cpuPercent.toFixed(0)}%`],['Memory free',`${gb(metrics.memoryFree)} / ${gb(metrics.memoryTotal)}`],['Disk free',metrics.diskFree === null ? 'Unavailable' : `${gb(metrics.diskFree)} / ${gb(metrics.diskTotal || 0)}`]].map(([label,value], index) => <div key={label} data-tone={index} className="metric-tile rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-lg font-semibold">{value}</p></div>)}</div>
        <div className="rounded-xl border border-border p-4 text-xs leading-6 text-muted-foreground"><p>{metrics.hostname} · {metrics.addresses.join(', ')} · uptime {(metrics.uptime / 86400).toFixed(1)} days</p><p>{Object.entries(metrics.tools).map(([tool,value]) => `${tool}: ${value || 'missing'}`).join(' · ')}</p><p>Last seen {server?.last_seen_at ? new Date(server.last_seen_at).toLocaleString() : '—'} · agent {metrics.version}</p></div>
      </>}
      {!editing && view === 'domains' && server.has_ca && <div className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">LAN certificate trust</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Distribute this server’s public root CA through your institution’s device policy or trust store. This enables trusted HTTPS for internal hostnames and IP access. Internal DNS must point each name to this server. The certificate is public; private keys stay on the server.</p><Button asChild variant="outline" size="sm" className="mt-3"><a href={`/api/servers/${id}/ca`}><Download className="mr-2 h-3.5 w-3.5" />Download root CA</a></Button></div>}
      {!editing && view === 'server-access' && infraSection === 'agent' && <AgentUpdates server={server} admin={admin} onChanged={() => void load()} />}
      {view === 'new' && admin && <RemoteAppImport server={server} onDirtyChange={setFormDirty} onCreated={appId => { setEditing(null); setFormDirty(false); void load().then(() => router.push(`${root}?tab=setup#app-${appId}`)) }} onCancel={() => { setEditing(null); setFormDirty(false); router.push(`${root}#applications`) }} />}
      {editing && editing !== 'new' && <RemoteAppForm key={editing.id} serverId={id} platform={server.platform} app={editing} onDirtyChange={setFormDirty} onSaved={() => { setEditing(null); setFormDirty(false); void load() }} onCancel={() => { setEditing(null); setFormDirty(false) }} />}
      {!editing && view === 'overview' && <RemoteServerOverview server={server} apps={summary.apps} jobs={summary.jobs} now={now} loadError={!!loadError} canCreate={admin && server.enabled && !sshBusy} />}
      {!editing && view === 'applications' && <RemoteApplications now={now} server={server} apps={summary.apps} jobs={summary.jobs} fresh={summary.fresh} />}
      {!editing && (view === 'storage' || view === 'domains') && <RemoteResources apps={summary.apps} mode={view} />}
      {!editing && selected && <TabsContent value={appTab} className="mt-0"><RemoteApplicationWorkspace key={selected.id} server={server} app={selected} apps={summary.apps} jobs={summary.jobs} tab={appTab} now={now} fresh={summary.fresh} admin={admin} deployer={deployer}
        onTab={changeTab} onChanged={() => void load()} onDirtyChange={setFormDirty} onEdit={() => setEditing(selected)}
        onDeploy={async () => { if (await action(`/apps/${selected.id}/deploy`)) router.push(remoteAppHref(id, selected.id, 'deployments')) }} /></TabsContent>}
      {!editing && view === 'app' && !selected && <div className="notice-error">This application is no longer available on {server.name}. <Link href={`${root}#applications`} className="underline">View projects</Link></div>}
      {!editing && view === 'deployments' && (openedJob ? <RemoteDeployment job={openedJob} apps={summary.apps} now={now} canCancel={deployer && server.enabled} busy={busy} onCancel={() => void action(`/jobs/${openedJob.id}/cancel`)} /> : params.get('view') ? <div className="notice-error">This deployment is not in this server’s recent history. <Link href={`${root}#deployments`} className="underline">View deployments</Link></div> : <><DeploymentHistory deployments={summary.jobs.map(job => remoteDeployment(job, summary.apps))} now={now} projectsHref={`${root}#applications`} /><p className="mt-3 text-xs text-muted-foreground">Latest 30 deployment records from this server.</p></>)}
      {view === 'new' && !admin && <div className="notice-error">An administrator can create applications on this server.</div>}
      {!editing && view === 'server-access' && infraSection === 'processes' && <section className="rounded-xl border border-border bg-card"><h2 className="border-b border-border p-4 text-sm font-semibold">Application processes</h2><div className="divide-y divide-border">{summary.apps.map(app => { const process = metrics?.apps.find(item => item.id === app.id); return <Link key={app.id} href={remoteAppHref(id,app.id)} className="flex items-center justify-between gap-3 p-4 text-sm hover:bg-accent"><span>{app.name}</span><span className="text-xs text-muted-foreground">{summary.fresh ? process?.status || 'Not running' : 'Unknown'} · {process ? `${process.cpu.toFixed(0)}% CPU · ${gb(process.memory)}` : 'Awaiting process report'}</span></Link>})}</div></section>}
      {!editing && view === 'server-access' && ['health','runtimes'].includes(infraSection) && !metrics && <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">Connect this server to receive health and tool reports.</p>}
      {!editing && view === 'server-access' && infraSection === 'agent' && <section id="server-access" className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">Agent access</h2><p className="mt-2 text-sm text-muted-foreground">{server.status === 'pending' ? 'Finish SSH setup above to connect this server.' : server.status === 'revoked' ? 'Agent access has been revoked.' : 'This server connects to Manager using its own agent credential.'}</p>{admin && server.enabled && <><Button asChild variant="outline" size="sm" className="mt-3 mr-2"><a href="/api/servers/agent" download="manager-agent.cjs">Download current agent</a></Button><p className="mt-2 text-xs text-muted-foreground">Use Agent updates above for supervised upgrades. Existing installations can follow the one-time supervisor guide while keeping their server enrollment and applications.</p>{!revoke ? <Button variant="outline" size="sm" className="mt-3" onClick={() => setRevoke(true)}>Revoke agent access…</Button> : <><p className="mt-2 text-sm leading-6 text-muted-foreground">This invalidates the agent credential and cancels its queued jobs. An operation already running may finish locally. Existing apps and Caddy continue running. This server cannot reconnect with its current credential.</p><div className="mt-3 flex gap-2"><Button disabled={busy} variant="destructive" onClick={() => void action('', { action: 'revoke' })}>Revoke access</Button><Button variant="outline" onClick={() => setRevoke(false)}>Keep connected</Button></div></>}</>}</section>}
    </div>
  </AppShell></Tabs>
}
