'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Download, Plus, RefreshCw, Rocket } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { RemoteAppForm } from '@/components/infrastructure/remote-app-form'
import { RemoteServerOverview, remoteJobLabels, remoteJobTone } from '@/components/infrastructure/remote-server-overview'
import { remoteOverview, remoteWorkspaceView } from '@/lib/remote-server-overview'
import { relativeTime } from '@/lib/deployment-stages'
import { ServerEnrollment } from '@/components/infrastructure/server-enrollment'
import { ServerSshSetup } from '@/components/infrastructure/server-ssh-setup'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
type Detail = { server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; role: string }

export default function ManagedServerPage() {
  const { id } = useParams<{ id: string }>()
  return <ManagedServerWorkspace key={id} id={id} />
}

function ManagedServerWorkspace({ id }: { id: string }) {
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
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const server = data?.server, metrics = server?.metrics, admin = data?.role === 'admin', deployer = admin || data?.role === 'operator'
  if (!server) return <AppShell title={loadError ? 'Server unavailable' : 'Opening server…'} subtitle={loadError ? 'Choose another server or retry the connection.' : 'Loading this server’s workspace.'} back={{ href: '/', label: 'All servers' }}>
    {loadError ? <div role="alert" className="notice-error"><p>{loadError}</p><Button variant="outline" className="mt-3" onClick={() => void load()}>Retry</Button></div> : <p role="status" className="text-sm text-muted-foreground">Loading server…</p>}
  </AppShell>
  const summary = remoteOverview(server, data?.apps || [], data?.jobs || [], now, !!loadError)
  const selected = view === 'app' ? summary.apps.find(app => hash === `#app-${app.id}`) : undefined
  const titles = { overview: server.name, applications: 'Applications', deployments: 'Deployments', 'server-access': 'Server access', app: selected?.name || 'Application unavailable' }
  const title = editing ? editing === 'new' ? 'New application' : `Edit ${editing.name}` : titles[view]
  const visibleApps = selected ? [selected] : summary.apps
  const visibleJobs = selected ? summary.jobs.filter(job => job.app_id === selected.id) : summary.jobs
  const notice = 'rounded-lg border border-status-building/25 bg-status-building/5 p-4 text-sm leading-6 text-status-building'
  return <AppShell title={title} onWorkspaceHashChange={setHash} unsavedChanges={formDirty} workspace={{ destinations: Object.fromEntries(summary.apps.map(app => [`#app-${app.id}`, app.name])) }} subtitle={`${view === 'overview' ? '' : `${server.name} · `}${server.platform === 'win32' ? 'Windows' : 'Linux'}${server.location ? ` · ${server.location}` : ''} · ${server.status}`} back={view === 'app' ? { href: `${root}#applications`, label: 'Applications' } : { href: '/', label: 'All servers' }}
    actions={<><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button>{admin && server.enabled && !editing && <Button size="sm" disabled={sshBusy} onClick={() => setEditing('new')}><Plus className="mr-1.5 h-4 w-4" />New app</Button>}</>}>
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
      {!editing && view === 'server-access' && metrics && <>
        <div className="grid gap-3 sm:grid-cols-3">{[['CPU',`${metrics.cpuPercent.toFixed(0)}%`],['Memory free',`${gb(metrics.memoryFree)} / ${gb(metrics.memoryTotal)}`],['Disk free',metrics.diskFree === null ? 'Unavailable' : `${gb(metrics.diskFree)} / ${gb(metrics.diskTotal || 0)}`]].map(([label,value], index) => <div key={label} data-tone={index} className="metric-tile rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-lg font-semibold">{value}</p></div>)}</div>
        <div className="rounded-xl border border-border p-4 text-xs leading-6 text-muted-foreground"><p>{metrics.hostname} · {metrics.addresses.join(', ')} · uptime {(metrics.uptime / 86400).toFixed(1)} days</p><p>{Object.entries(metrics.tools).map(([tool,value]) => `${tool}: ${value || 'missing'}`).join(' · ')}</p><p>Last seen {server?.last_seen_at ? new Date(server.last_seen_at).toLocaleString() : '—'} · agent {metrics.version}</p></div>
      </>}
      {!editing && view === 'server-access' && server.has_ca && <div className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">LAN certificate trust</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Distribute this server’s public root CA through your institution’s device policy or trust store. This enables trusted HTTPS for internal hostnames and IP access. Internal DNS must point each name to this server. The certificate is public; private keys stay on the server.</p><Button asChild variant="outline" size="sm" className="mt-3"><a href={`/api/servers/${id}/ca`}><Download className="mr-2 h-3.5 w-3.5" />Download root CA</a></Button></div>}
      {editing && <RemoteAppForm key={editing === 'new' ? 'new' : editing.id} serverId={id} platform={server.platform} app={editing === 'new' ? undefined : editing} onDirtyChange={setFormDirty} onSaved={() => { setEditing(null); setFormDirty(false); void load() }} onCancel={() => { setEditing(null); setFormDirty(false) }} />}
      {!editing && view === 'overview' && <RemoteServerOverview server={server} apps={summary.apps} jobs={summary.jobs} now={now} loadError={!!loadError} canCreate={admin && server.enabled && !sshBusy} onCreate={() => setEditing('new')} />}
      {!editing && (view === 'applications' || (view === 'app' && selected)) && <section id="applications" className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{selected ? 'At a glance' : `Applications on ${server.name}`}</h2>{!selected && <span className="text-xs text-muted-foreground">{summary.apps.length} total</span>}</div>{!visibleApps.length && <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No applications yet. Create an app, choose its repository and LAN or WAN hostname, then deploy.</p>}
        <div className={selected ? '' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-3'}>{visibleApps.map(app => {
          const process = metrics?.apps.find(p => p.id === app.id)
          const activeJob = summary.active.find(job => job.app_id === app.id)
          return <article key={app.id} id={`app-${app.id}`} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold"><Link href={`${root}#app-${app.id}`} className="underline-offset-4 hover:text-primary hover:underline">{app.name}</Link></h3><p className={`mt-1 text-xs ${summary.fresh && process?.status === 'online' ? 'text-status-ready' : 'text-muted-foreground'}`}>{summary.fresh ? process?.status === 'online' ? 'Running' : process?.status || 'Not deployed' : `Last status: ${process?.status || 'unknown'}`}</p></div><span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{app.access_mode.toUpperCase()}</span></div>
            <a href={`https://${app.hostname}`} target="_blank" rel="noreferrer" className="mt-3 block break-all text-sm underline">https://{app.hostname}</a>
            {selected && app.ip_address && <a href={`https://${app.ip_address.includes(':') ? `[${app.ip_address}]` : app.ip_address}:${app.ip_port}`} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-muted-foreground underline">IP access: {app.ip_address}:{app.ip_port} (local CA)</a>}
            <p className="mt-2 truncate text-xs text-muted-foreground">{app.branch} · port {app.port}</p>
            {selected && <div className="mt-4 grid gap-4 border-t border-border pt-4 text-xs sm:grid-cols-2"><div><p className="font-medium">Repository</p><p className="mt-1 break-all text-muted-foreground">{app.repo_url}</p></div><div><p className="font-medium">Health check</p><p className="mt-1 text-muted-foreground">{app.health_path} · checked during deployment</p></div><div><p className="font-medium">Environment</p><p className="mt-1 text-muted-foreground">{app.env_names.length} configured variables · values kept private</p></div><div><p className="font-medium">HTTPS</p><p className="mt-1 text-muted-foreground">{app.access_mode === 'lan' ? 'Institution hostname · local certificate authority' : 'Public hostname · public certificate authority'}</p></div></div>}
            <p className="mt-2 text-[11px] text-muted-foreground">{app.live_commit ? `${app.live_commit.slice(0,7)} · released ${relativeTime(app.deployed_at, now)}` : 'No successful deployment yet'}</p>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">{selected ? admin && server.enabled && <Button variant="outline" size="sm" disabled={!!activeJob} onClick={() => setEditing(app)}>Edit settings</Button> : <Button asChild variant="outline" size="sm"><Link href={`${root}#app-${app.id}`}>Open app</Link></Button>}{deployer && server.enabled && <Button size="sm" disabled={busy || !!activeJob || !server.enrolled_at} onClick={() => void action(`/apps/${app.id}/deploy`)}><Rocket className="mr-1.5 h-3 w-3" />{activeJob ? remoteJobLabels[activeJob.status] : 'Deploy'}</Button>}</div>
          </article>
        })}</div>
      </section>}
      {!editing && view === 'app' && !selected && <div className="notice-error">This application is no longer available on {server.name}. <Link href={`${root}#applications`} className="underline">View applications</Link></div>}
      {!editing && (view === 'deployments' || (view === 'app' && selected)) && <section id="deployments" className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Deployment history</h2><span className="text-[11px] text-muted-foreground">Latest 30 server records</span></div>
        {!visibleJobs.length && <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No deployments yet. Build output and release history will appear here.</p>}
        {visibleJobs.map(job => <details key={`${job.id}:${params.get('view') === job.id}`} className="overflow-hidden rounded-xl border border-border bg-card" open={params.get('view') === job.id || ['running','queued'].includes(job.status) || undefined}>
          <summary className="cursor-pointer px-4 py-3 text-sm"><span className="font-medium">{job.app_name}</span><span className={`ml-3 text-xs ${remoteJobTone[job.status]}`}>{remoteJobLabels[job.status]}</span><span className="ml-3 text-xs text-muted-foreground">{relativeTime(job.created_at, now)}</span></summary>
          <div className="border-t border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{new Date(job.created_at).toLocaleString()} · {job.commit_sha?.slice(0, 12) || 'Awaiting commit'}</span><Link href={`${root}#app-${job.app_id}`} className="text-primary hover:underline">Open application</Link></div>
            {job.status === 'queued' && deployer && <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void action(`/jobs/${job.id}/cancel`)}>Cancel queued deployment</Button>}
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono text-xs leading-5">{job.log || (job.status === 'queued' ? 'Waiting for the agent…' : 'Waiting for deployment output…')}</pre>
          </div>
        </details>)}
      </section>}
      {!editing && view === 'server-access' && <section id="server-access" className="rounded-xl border border-border bg-card p-5"><h2 className="text-sm font-semibold">Agent access</h2><p className="mt-2 text-sm text-muted-foreground">{server.status === 'pending' ? 'Finish SSH setup above to connect this server.' : server.status === 'revoked' ? 'Agent access has been revoked.' : 'This server connects to Manager using its own agent credential.'}</p>{admin && server.enabled && <>{!revoke ? <Button variant="outline" size="sm" className="mt-3" onClick={() => setRevoke(true)}>Revoke agent access…</Button> : <><p className="mt-2 text-sm leading-6 text-muted-foreground">This invalidates the agent credential and cancels its queued jobs. An operation already running may finish locally. Existing apps and Caddy continue running. This server cannot reconnect with its current credential.</p><div className="mt-3 flex gap-2"><Button disabled={busy} variant="destructive" onClick={() => void action('', { action: 'revoke' })}>Revoke access</Button><Button variant="outline" onClick={() => setRevoke(false)}>Keep connected</Button></div></>}</>}</section>}
    </div>
  </AppShell>
}
