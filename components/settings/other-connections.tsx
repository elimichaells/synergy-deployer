'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Cloud, Database } from 'lucide-react'
import { ProviderLogo, type Provider } from '@/components/app/providers'

interface CloudflareConnection { id: string; name: string; token_last_four: string; token_status: string; domain_count: number }
interface DatabaseServer { id: string; name: string; provider: Provider; host: string; port: number; last_status: string; service_count: number }

function Status({ value }: { value: string }) {
  const good = ['active', 'healthy', 'valid', 'ok'].includes(value)
  const bad = ['failed', 'invalid', 'error', 'expired'].includes(value)
  return <span className={`rounded-full border px-2 py-px text-[11px] capitalize ${good ? 'border-status-ready/30 text-emerald-300' : bad ? 'border-red-500/30 text-red-300' : 'border-border text-muted-foreground'}`}>{value || 'unknown'}</span>
}

/** Cloudflare accounts and database servers, so every connection Synergy holds is visible in one place. */
export function OtherConnections({ isAdmin }: { isAdmin: boolean }) {
  const [cloudflare, setCloudflare] = useState<CloudflareConnection[] | null>(null)
  const [servers, setServers] = useState<DatabaseServer[] | null>(null)

  useEffect(() => {
    void fetch('/api/cloudflare/connections', { cache: 'no-store' }).then(response => response.ok ? response.json() : { connections: [] }).then(body => setCloudflare(body.connections || [])).catch(() => setCloudflare([]))
    if (isAdmin) void fetch('/api/data/connections', { cache: 'no-store' }).then(response => response.ok ? response.json() : { connections: [] }).then(body => setServers(body.connections || [])).catch(() => setServers([]))
    else setServers([])
  }, [isAdmin])

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold">Cloudflare</h3><p className="text-xs text-muted-foreground">Accounts Synergy uses to create DNS records and HTTPS settings for your domains.</p></div>
          <Link href="/domains" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Manage<ArrowUpRight className="h-3.5 w-3.5" /></Link>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {(cloudflare || []).map(connection => (
            <div key={connection.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <Cloud className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{connection.name}</span><span className="block text-xs text-muted-foreground">Token ending {connection.token_last_four} · {connection.domain_count} domain{connection.domain_count === 1 ? '' : 's'}</span></span>
              <Status value={connection.token_status} />
            </div>
          ))}
          {cloudflare && !cloudflare.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No Cloudflare account connected. <Link href="/domains" className="text-foreground underline-offset-4 hover:underline">Connect one in Domains &amp; DNS</Link>.</p>}
          {!cloudflare && <div className="h-14 animate-pulse bg-card" />}
        </div>
      </div>
      {isAdmin && <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold">Database servers</h3><p className="text-xs text-muted-foreground">Servers Synergy signs in to so apps can have their own databases.</p></div>
          <Link href="/storage?tab=servers" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">Manage<ArrowUpRight className="h-3.5 w-3.5" /></Link>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {(servers || []).map(server => (
            <div key={server.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              {server.provider ? <ProviderLogo provider={server.provider} size="sm" /> : <Database className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{server.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{server.host}:{server.port} · {server.service_count} database{server.service_count === 1 ? '' : 's'}</span></span>
              <Status value={server.last_status} />
            </div>
          ))}
          {servers && !servers.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No database servers yet. <Link href="/storage?tab=servers" className="text-foreground underline-offset-4 hover:underline">Add one in Storage</Link>.</p>}
          {!servers && <div className="h-14 animate-pulse bg-card" />}
        </div>
      </div>}
    </div>
  )
}
