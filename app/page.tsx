'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Check, MapPin, Plus, Search, Server } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { serverStatusColor, serverStatusLabel, useServerDirectory } from '@/components/infrastructure/server-directory'
import { recentServerKey, serverOverview } from '@/lib/server-navigation'
import { useWorkspace } from '@/components/layout/workspace-provider'

function ServerChooser() {
  const { data, error, refresh } = useServerDirectory()
  const { resume } = useWorkspace()
  const [search, setSearch] = useState('')
  const [recentId, setRecentId] = useState<string | null>(null)
  useEffect(() => {
    if (!data?.userId) return
    try { setRecentId(localStorage.getItem(recentServerKey(data.userId))) } catch { /* Storage can be disabled. */ }
  }, [data?.userId])
  const recent = data?.servers.find(server => server.id === recentId && server.enabled)
  const recentName = recentId === 'local' ? 'Manager host' : recent?.name
  const query = search.trim().toLowerCase()
  const showLocal = ['Manager host', data?.local?.hostname, data?.local?.platform === 'win32' ? 'Windows' : 'Linux'].some(value => value?.toLowerCase().includes(query))
  const servers = (data?.servers || []).filter(server => [server.name, server.location, server.platform === 'win32' ? 'Windows' : 'Linux', server.metrics?.hostname, ...(server.metrics?.addresses || [])].some(value => value?.toLowerCase().includes(query)))

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <ol aria-label="Get started" className="flex items-center gap-3 text-xs sm:gap-5 sm:text-sm">
        <li className="flex items-center gap-2 font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-full border border-foreground/25 bg-white/[0.08] text-xs">1</span>Choose a server</li>
        <li aria-hidden="true"><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></li>
        <li className="flex items-center gap-2 text-muted-foreground"><span className="flex h-6 w-6 items-center justify-center rounded-full border border-border text-xs">2</span>Open its workspace</li>
      </ol>
      {data?.role === 'admin' && <Button asChild size="sm"><Link href="/infrastructure/servers?add=1"><Plus className="mr-1.5 h-4 w-4" />Add server</Link></Button>}
    </div>
    {recentName && recentId && <Link href={resume(recentId, data?.userId, data?.role)} className="continue-workspace flex items-center gap-3 rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/40">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.05]"><Server className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Last visited</span><span className="block truncate text-sm font-medium">Continue with {recentName}</span></span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Your servers{data && <span className="ml-2 font-normal text-muted-foreground">{data.servers.length + 1}</span>}</h2>{data && !error && <p className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground"><span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-status-ready" />{data.servers.filter(server => server.status === 'online').length} remote reporting</span>{data.servers.some(server => server.status === 'pending') && <span className="text-amber-400">{data.servers.filter(server => server.status === 'pending').length} awaiting setup</span>}</p>}</div>
      <label className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 sm:w-80"><Search className="h-4 w-4 text-muted-foreground" /><span className="sr-only">Find a server</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, location or address…" className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" /></label>
    </div>
    {error && <div role="alert" className="notice-error flex flex-wrap items-center justify-between gap-3"><span>{error}. Server statuses may be out of date.</span><Button variant="outline" size="sm" onClick={refresh}>Retry</Button></div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {showLocal && <Link href="/overview" className="syn-tile flex min-w-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2.5">
          <span className="workspace-tab-icon is-local"><Server className="h-4 w-4" /></span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">Manager host</h3>
          <span className="shrink-0 text-[11px] text-muted-foreground">This server</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{data?.local?.hostname || 'The server running Synergy'}{data?.local?.platform && ` · ${data.local.platform === 'win32' ? 'Windows' : 'Linux'}`}</p>
        <span className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-xs font-medium">Open overview<ArrowRight className="h-3.5 w-3.5" /></span>
      </Link>}
      {servers.map(server => <Link key={server.id} href={serverOverview(server.id)} className="syn-tile flex min-w-0 flex-col gap-3 p-4">
        <div className="flex items-center gap-2.5">
          <span className="workspace-tab-icon is-remote"><Server className="h-4 w-4" /></span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={server.name}>{server.name}</h3>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px]"><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${error ? 'bg-zinc-500' : serverStatusColor[server.status]}`} />{error ? 'Unknown' : serverStatusLabel[server.status]}</span>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><span className="shrink-0">{server.platform === 'win32' ? 'Windows' : 'Linux'}</span><span aria-hidden="true">·</span><MapPin className="h-3 w-3 shrink-0" /><span className="truncate" title={server.location || server.metrics?.hostname}>{server.location || server.metrics?.hostname || 'Location not set'}</span></p>
        <span className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5 text-xs"><span className="text-muted-foreground">{server.app_count} app{server.app_count === 1 ? '' : 's'}</span><span className="inline-flex items-center gap-2 font-medium">{server.status === 'pending' ? 'Finish setup' : server.status === 'revoked' ? 'View details' : 'Open overview'}<ArrowRight className="h-3.5 w-3.5" /></span></span>
      </Link>)}
      {!data && !error && <div role="status" className="flex min-h-32 items-center justify-center rounded-xl border border-border text-sm text-muted-foreground">Loading your servers…</div>}
    </div>
    {query && !showLocal && !servers.length && data && <p role="status" className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No servers match “{search}”. Try a name, location or address.</p>}
    {data?.servers.length === 0 && !query && <div className="rounded-xl border border-dashed border-border p-5"><h3 className="text-sm font-medium">Ready when you add more servers</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">Start with the manager host, or {data.role === 'admin' ? 'add a Windows or Linux server using its SSH address and credentials' : 'ask an administrator to connect another server'}. Each server has its own applications and deployment history.</p></div>}
    <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"><Check className="h-3.5 w-3.5 shrink-0" />You can switch servers at any time from the selector beside Synergy.</p>
  </div>
}

export default function Home() {
  return <AppShell title="Choose a server" subtitle="Open a server to see its applications, deployments and health."><ServerChooser /></AppShell>
}
