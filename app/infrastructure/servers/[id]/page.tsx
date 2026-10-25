'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Download, Plus, RefreshCw, Rocket } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { RemoteAppForm } from '@/components/infrastructure/remote-app-form'
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
    try {
      const response = await fetch(`/api/servers/${id}`, { cache: 'no-store' }); const result = await response.json()
      if (!response.ok || !result.server || result.server.id !== id) throw new Error(result.error || 'Could not load server')
      setData(result); setLoadError('')
    } catch (err) { setLoadError((err as Error).message) }
  }, [id])
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 10000); return () => clearInterval(timer) }, [load])
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
  return <AppShell title={server?.name || 'Server'} subtitle={server ? `${server.platform === 'win32' ? 'Windows' : 'Linux'}${server.location ? ` · ${server.location}` : ''} · ${server.status}` : 'Loading server…'} area="infrastructure" back={{ href: '/', label: 'All servers' }}
    actions={<><Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>{admin && server?.enabled && <Button size="sm" onClick={() => setEditing('new')}><Plus className="mr-2 h-4 w-4" />New app</Button>}</>}>
    <div className="space-y-6">
      {(error || loadError) && <p role="alert" className="notice-error">{error || loadError}</p>}
      {server && (server.status === 'pending' || sshSession) && admin && <>
        {server.status === 'pending' && <div className="flex gap-2"><Button disabled={sshBusy} variant={manual ? 'outline' : 'default'} onClick={() => { setManual(false); setEnrollment(null) }}>Connect with SSH</Button><Button disabled={sshBusy} variant={manual ? 'default' : 'outline'} onClick={() => { setManual(true); setSshSession(false) }}>Install agent manually</Button></div>}
        {!manual ? <ServerSshSetup serverId={id} platform={server.platform} onConnected={() => void load()} onBusyChange={value => { setSshBusy(value); if (value) setSshSession(true) }} /> : <div className="rounded-xl border border-border p-5"><h2 className="font-semibold">Install the agent manually</h2><p className="mt-2 text-sm text-muted-foreground">Use this when SSH is unavailable or the server cannot receive an inbound connection from Manager.</p><Button className="mt-3" variant="outline" disabled={busy} onClick={() => void action('', { action: 'enrollment' })}>Create enrollment instructions</Button></div>}
        {server.enrolled_at && !sshBusy && <Button variant="outline" onClick={() => setSshSession(false)}>Close setup</Button>}
      </>}
      {enrollment && server && <ServerEnrollment id={id} token={enrollment} platform={server.platform} onDismiss={() => setEnrollment(null)} />}
      {server?.status === 'offline' && <p className="rounded-lg border border-amber-500/30 p-4 text-sm text-amber-200">No heartbeat for more than 90 seconds. These are last reported values. New deployments wait in the queue; a running deployment is never automatically replayed.</p>}
      {server?.status === 'revoked' && <p className="rounded-lg border border-border p-4 text-sm">Agent access has been revoked. Existing apps may still be running on the server. Inspect and manage them locally.</p>}
      {metrics && <>
        <div className="grid gap-3 sm:grid-cols-3">{[['CPU',`${metrics.cpuPercent.toFixed(0)}%`],['Memory free',`${gb(metrics.memoryFree)} / ${gb(metrics.memoryTotal)}`],['Disk free',metrics.diskFree === null ? 'Unavailable' : `${gb(metrics.diskFree)} / ${gb(metrics.diskTotal || 0)}`]].map(([label,value]) => <div key={label} className="rounded-xl border border-border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-lg font-semibold">{value}</p></div>)}</div>
        <div className="rounded-xl border border-border p-4 text-xs leading-6 text-muted-foreground"><p>{metrics.hostname} · {metrics.addresses.join(', ')} · uptime {(metrics.uptime / 86400).toFixed(1)} days</p><p>{Object.entries(metrics.tools).map(([tool,value]) => `${tool}: ${value || 'missing'}`).join(' · ')}</p><p>Last seen {server?.last_seen_at ? new Date(server.last_seen_at).toLocaleString() : '—'} · agent {metrics.version}</p>{metrics.proxyError && <p className="text-amber-200">{metrics.proxyError}</p>}</div>
      </>}
      {server?.has_ca && <div className="rounded-xl border border-border p-5"><h2 className="font-semibold">LAN certificate trust</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Distribute this server’s public root CA through your institution’s device policy or trust store. This enables trusted HTTPS for internal hostnames and IP access. Internal DNS must point each name to this server. The certificate is public; private keys stay on the server.</p><Button asChild variant="outline" className="mt-3"><a href={`/api/servers/${id}/ca`}><Download className="mr-2 h-4 w-4" />Download root CA</a></Button></div>}
      {editing && server && <RemoteAppForm key={editing === 'new' ? 'new' : editing.id} serverId={id} platform={server.platform} app={editing === 'new' ? undefined : editing} onSaved={() => { setEditing(null); void load() }} onCancel={() => setEditing(null)} />}
      <section id="applications" className="scroll-mt-36 space-y-3"><h2 className="font-semibold">Applications</h2>{data?.apps.length === 0 && <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No applications yet. Create an app, choose its repository and LAN or WAN hostname, then deploy.</p>}
        {data?.apps.map(app => {
          const process = metrics?.apps.find(p => p.id === app.id)
          const activeJob = data.jobs.find(job => job.app_id === app.id && ['queued','running'].includes(job.status))
          return <article key={app.id} id={`app-${app.id}`} className="scroll-mt-36 rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{app.name}</h3><p className="mt-1 text-xs text-muted-foreground">{app.branch} · {app.access_mode.toUpperCase()} · port {app.port} · {server?.status === 'online' ? process?.status || 'not deployed' : `last status: ${process?.status || 'unknown'}`}</p></div><div className="flex gap-2">{admin && server?.enabled && <Button variant="outline" size="sm" disabled={!!activeJob} onClick={() => setEditing(app)}>Edit</Button>}{deployer && server?.enabled && <Button size="sm" disabled={busy || !!activeJob || !server.enrolled_at} onClick={() => void action(`/apps/${app.id}/deploy`)}><Rocket className="mr-2 h-3.5 w-3.5" />{activeJob ? activeJob.status : 'Deploy'}</Button>}</div></div>
            <a href={`https://${app.hostname}`} target="_blank" rel="noreferrer" className="mt-3 block break-all text-sm underline">https://{app.hostname}</a>
            {app.ip_address && <a href={`https://${app.ip_address.includes(':') ? `[${app.ip_address}]` : app.ip_address}:${app.ip_port}`} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-muted-foreground underline">IP access: {app.ip_address}:{app.ip_port} (local CA)</a>}
            <p className="mt-2 break-all text-xs text-muted-foreground">{app.repo_url}</p>
            <p className="mt-2 text-xs text-muted-foreground">{app.live_commit ? `Live commit ${app.live_commit.slice(0,12)} · ${new Date(app.deployed_at!).toLocaleString()}` : 'No successful deployment yet'}</p>
          </article>
        })}
      </section>
      <section id="deployments" className="scroll-mt-36 space-y-3"><h2 className="font-semibold">Recent deployments</h2>{data?.jobs.length === 0 && <p className="text-sm text-muted-foreground">Deployment logs will appear here.</p>}{data?.jobs.map(job => <details key={job.id} className="rounded-xl border border-border bg-card" open={['running','queued'].includes(job.status) || undefined}><summary className="cursor-pointer p-4 text-sm"><span className="font-medium">{job.app_name}</span><span className={`ml-3 capitalize ${job.status === 'failed' ? 'text-red-300' : job.status === 'success' ? 'text-emerald-300' : 'text-muted-foreground'}`}>{job.status}</span><span className="ml-3 text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString()}</span></summary><div className="border-t border-border p-4">{job.status === 'queued' && deployer && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(`/jobs/${job.id}/cancel`)}>Cancel queued deployment</Button>}<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-xs leading-5">{job.log || (job.status === 'queued' ? 'Waiting for the agent…' : 'Waiting for deployment output…')}</pre></div></details>)}</section>
      <section id="server-access" className="scroll-mt-36 rounded-xl border border-border p-5"><h2 className="font-semibold">Server access</h2><p className="mt-2 text-sm text-muted-foreground">{server?.status === 'pending' ? 'Finish SSH setup above to connect this server.' : server?.status === 'revoked' ? 'Agent access has been revoked.' : 'This server connects to Manager using its own agent credential.'}</p>{admin && server?.enabled && <>{!revoke ? <Button variant="outline" className="mt-3" onClick={() => setRevoke(true)}>Revoke agent access…</Button> : <><p className="mt-2 text-sm leading-6 text-muted-foreground">This invalidates the agent credential and cancels its queued jobs. An operation already running may finish locally. Existing apps and Caddy continue running. This server cannot reconnect with its current credential.</p><div className="mt-3 flex gap-2"><Button disabled={busy} variant="destructive" onClick={() => void action('', { action: 'revoke' })}>Revoke access</Button><Button variant="outline" onClick={() => setRevoke(false)}>Keep connected</Button></div></>}</>}</section>
    </div>
  </AppShell>
}
