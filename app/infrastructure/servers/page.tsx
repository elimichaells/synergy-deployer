'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Plus, Server } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import type { ManagedServer } from '@/lib/managed-server-types'

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

export default function ServersPage() {
  const [servers, setServers] = useState<ManagedServer[] | null>(null)
  const [role, setRole] = useState('viewer')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', location: '', platform: 'win32' })
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/servers', { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load servers')
      setServers(result.servers); setRole(result.role); setError('')
    } catch (err) { setError((err as Error).message) }
  }, [])
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15000); return () => clearInterval(timer) }, [load])
  async function add(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not add server')
      window.location.assign(`/infrastructure/servers/${result.id}`)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return <AppShell title="Servers" subtitle="Deploy and monitor Windows and Linux servers across your network and other locations." area="infrastructure"
    actions={role === 'admin' && <Button size="sm" onClick={() => setAdding(value => !value)}><Plus className="mr-2 h-4 w-4" />Add server</Button>}>
    <div className="space-y-5">
      {error && <p role="alert" className="notice-error">{error}</p>}
      {adding && <form onSubmit={add} className="space-y-4 rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Add a server</h2><div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Server name<input required maxLength={100} className="mt-1 w-full rounded-md border border-border bg-background p-2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Campus application server" /></label>
        <label className="text-sm">Location<input maxLength={100} className="mt-1 w-full rounded-md border border-border bg-background p-2" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} placeholder="Main campus / Accra" /></label>
        <label className="text-sm">Operating system<select className="mt-1 w-full rounded-md border border-border bg-background p-2" value={form.platform} onChange={e => setForm({ ...form, platform: e.target.value })}><option value="win32">Windows</option><option value="linux">Linux</option></select></label>
      </div><div className="flex gap-2"><Button disabled={busy} type="submit">{busy ? 'Adding…' : 'Continue to connection'}</Button><Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancel</Button></div></form>}
      <Link href="/infrastructure/health" className="flex items-center gap-4 rounded-xl border border-border bg-card p-5"><Server className="h-5 w-5" /><span className="flex-1"><span className="block text-sm font-semibold">Manager host</span><span className="mt-1 block text-xs text-muted-foreground">Existing local apps and infrastructure</span></span><ArrowRight className="h-4 w-4" /></Link>
      {!servers && !error && <p className="text-sm text-muted-foreground">Loading servers…</p>}
      {servers?.length === 0 && <div className="rounded-xl border border-dashed border-border p-8 text-center"><Server className="mx-auto mb-3 h-8 w-8 text-muted-foreground" /><h2 className="font-semibold">Connect your first remote server</h2><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">Add a Windows or Linux server, enroll its agent, then deploy apps with Caddy and readable HTTPS names. The agent connects outward to Manager, including across locations.</p></div>}
      <div className="grid gap-4 xl:grid-cols-2">{servers?.map(server => <Link key={server.id} href={`/infrastructure/servers/${server.id}`} className="syn-tile min-w-0 p-5">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-semibold">{server.name}</h2><p className="mt-1 text-xs text-muted-foreground">{server.platform === 'win32' ? 'Windows' : 'Linux'}{server.location && ` · ${server.location}`}</p></div><span className={`rounded-full border px-2 py-1 text-xs capitalize ${server.status === 'online' ? 'border-emerald-500/30 text-emerald-300' : server.status === 'offline' ? 'border-amber-500/30 text-amber-300' : 'border-border text-muted-foreground'}`}>{server.status}</span></div>
        <p className="mt-4 text-sm">{server.app_count} app{server.app_count === 1 ? '' : 's'}</p>
        {server.metrics && <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground"><span>CPU {server.metrics.cpuPercent.toFixed(0)}%</span><span>Free memory {gb(server.metrics.memoryFree)}</span><span>Free disk {server.metrics.diskFree === null ? 'unavailable' : gb(server.metrics.diskFree)}</span><span>{server.metrics.hostname}</span></div>}
        <p className="mt-3 text-xs text-muted-foreground">{server.last_seen_at ? `Last seen ${new Date(server.last_seen_at).toLocaleString()}` : 'Waiting for enrollment'}</p>
      </Link>)}</div>
      <p className="text-xs leading-5 text-muted-foreground">Samples refresh every 15 seconds. A server is shown offline after 90 seconds without a heartbeat. Last reported values remain visible while offline. Existing applications continue running if Manager becomes unreachable.</p>
    </div>
  </AppShell>
}
