'use client'

import { Section } from '@/components/app/section'
import { type Provider } from '@/components/app/providers'
import { Button } from '@/components/ui/button'
import { DatabaseList } from '@/components/workspace/database-list'
import type { RemoteApp } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDatabases } from '@/lib/remote-workspace'
import { ArrowUpRight, Database, Search } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'

export function RemoteResources({ apps, mode }: { apps: RemoteApp[]; mode: 'storage' | 'domains' }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const databases = remoteDatabases(apps)
  const visible = databases.filter(row => [row.config.database, row.config.host, ...row.apps.map(app => app.name)].some(value => value.toLowerCase().includes(query)))
  const domains = apps.filter(app => !app.hostname.endsWith('.invalid'))
  return <>
    {mode === 'storage' ? <>
      <div className="relative mb-4"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input aria-label="Search databases" className="control-input pl-9" placeholder="Search databases, apps or servers…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      {visible.length ? <DatabaseList rows={visible.map(row => ({ id: row.key, database: row.config.database, engine: row.config.provider as Provider, href: remoteAppHref(row.apps[0].server_id, row.apps[0].id, 'storage'), applications: row.apps.map(app => app.name).join(', '), detail: `${row.config.host}:${row.config.port} · ${[...new Set(row.apps.map(app => app.environment_name || 'production'))].join(', ')}`, size: 'Not reported', backup: <span className="text-muted-foreground">Not reported by agent</span>, warnings: row.apps.some(app => app.database_config?.status !== 'ready') ? 1 : 0 }))} />
        : <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16 text-center"><Database className="mb-3 h-6 w-6 text-muted-foreground" /><p className="text-sm font-medium">{databases.length ? 'No matching databases' : 'No databases yet'}</p><p className="mt-1 max-w-sm text-xs text-muted-foreground">{databases.length ? 'Try a different search.' : 'Open an application below to configure its database connection.'}</p></div>}
    </> : <Section title="Domains" description="Web addresses for the applications on this server.">
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{domains.map(app => <div key={app.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5"><a href={`https://${app.hostname}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline"><span className="truncate">{app.hostname}</span><ArrowUpRight className="h-3.5 w-3.5 shrink-0" /></a><span className="text-xs text-muted-foreground">→ {app.name} · {app.environment_name || 'production'} · {app.access_mode.toUpperCase()} HTTPS</span><Link className="ml-auto text-xs text-muted-foreground hover:text-foreground" href={remoteAppHref(app.server_id, app.id, 'domains')}>Manage</Link></div>)}{!domains.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No domains yet. Choose an application below to connect an address.</p>}</div>
    </Section>}
    <Section title={mode === 'storage' ? 'Application connections' : 'Connect a domain'} description={mode === 'storage' ? 'Choose the application whose database connection you want to configure.' : 'Choose an application to configure its hostname and HTTPS.'}>
      <div className="divide-y divide-border">{apps.map(app => <div key={app.id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{app.name}</p><p className="mt-1 text-xs text-muted-foreground">{app.environment_name || 'production'}</p></div><Button asChild variant="outline" size="sm"><Link href={remoteAppHref(app.server_id, app.id, mode)}>{mode === 'storage' ? app.database_config ? 'Manage database' : 'Add database' : 'Configure domain'}</Link></Button></div>)}</div>
      {!apps.length && <p className="text-sm text-muted-foreground">Import an application to get started.</p>}
    </Section>
  </>
}
