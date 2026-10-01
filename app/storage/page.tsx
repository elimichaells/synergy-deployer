'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Database, Link2, Loader2, Plus, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { ProviderLogo, providerMeta, type Provider } from '@/components/app/providers'
import { relativeTime } from '@/lib/deployment-stages'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Flag, serverRoleLabel } from '@/components/storage/bits'

interface StorageApp { serviceId: string; projectId: string; name: string; environment: string; groupId: string | null; groupName: string | null; ownership: string }
interface StorageDatabase { key: string; id: string; database: string; engine: Provider; serverName: string; serverRole: 'system' | 'apps' | 'external'; sizeBytes: number | null; apps: StorageApp[]; backup: { lastStatus: string; lastFinishedAt: string | null; enabled: boolean; frequency: string } | null; warnings: string[] }
interface Found { projectId: string; projectName: string; environment: string; source: string; engine: Provider; host: string; port: number; database: string; username: string | null; connectionName: string | null; systemServer: boolean; external: boolean; superuser: boolean; usedBy: string[]; sharedWithProduction: boolean }

export default function StoragePage() {
  const [databases, setDatabases] = useState<StorageDatabase[] | null>(null)
  const [found, setFound] = useState<Found[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = async () => {
    setError('')
    try {
      const response = await fetch('/api/storage', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not load storage')
      setDatabases(body.databases); setFound(body.discovered); setIsAdmin(body.isAdmin); setNow(Date.now())
    } catch (err) { setError((err as Error).message); setDatabases(current => current || []) }
  }
  useEffect(() => { void load() }, [])

  const link = async (item: Found) => {
    setBusy(item.projectId + item.source); setError(''); setNotice('')
    try {
      const response = await fetch('/api/storage/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: item.projectId, source: item.source }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The database could not be linked')
      setNotice(`Linked ${item.database} to ${item.projectName}. Nothing in the app changed.`)
      await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const linkAll = async () => {
    for (const item of found) { await link(item) }
  }

  const visible = useMemo(() => (databases || []).filter(database => {
    const q = search.trim().toLowerCase()
    return !q || database.database.toLowerCase().includes(q) || database.apps.some(app => app.name.toLowerCase().includes(q) || app.groupName?.toLowerCase().includes(q)) || database.serverName.toLowerCase().includes(q)
  }), [databases, search])

  const total = (databases || []).reduce((sum, database) => sum + (database.sizeBytes || 0), 0)
  const atRisk = (databases || []).filter(database => database.warnings.length).length

  return (
    <AppShell
      title="Storage"
      subtitle={databases ? `${databases.length} databases · ${formatBytes(total)}${atRisk ? ` · ${atRisk} need attention` : ''}` : 'Every database your apps use.'}
      actions={<>
        <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button>
        <Button asChild size="sm"><Link href="/projects"><Plus className="mr-1.5 h-4 w-4" />Add database</Link></Button>
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}
      {notice && <p role="status" className="mb-5 rounded-md border border-status-ready/25 bg-status-ready/5 px-4 py-3 text-sm text-emerald-200">{notice}</p>}

      {found.length > 0 && (
        <section className="mb-8 overflow-hidden rounded-xl border border-status-building/30 bg-status-building/[0.03]">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-status-building/20 px-5 py-4">
            <div className="max-w-2xl">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-status-building" />Found in your apps · {found.length} not linked yet</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">These databases are already in use, configured in each app&apos;s environment file. Link them so Synergy can show them, back them up and warn you about risks. Linking changes nothing in the app or the database.</p>
            </div>
            {isAdmin && found.length > 1 && <Button size="sm" variant="outline" onClick={() => void linkAll()} disabled={busy !== null}>Link all {found.length}</Button>}
          </div>
          <div className="divide-y divide-border">
            {found.map(item => (
              <div key={item.projectId + item.source} className="flex flex-wrap items-center gap-4 px-5 py-3">
                <ProviderLogo provider={item.engine} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm"><span className="font-mono font-medium">{item.database}</span><span className="text-muted-foreground"> used by </span><Link href={`/sites/${item.projectId}?tab=storage`} className="hover:underline">{item.projectName}</Link></p>
                  <p className="truncate text-xs text-muted-foreground">{item.connectionName || `${item.host}:${item.port}`} · {item.source}{item.usedBy.length ? ` · also used by ${item.usedBy.join(', ')}` : ''}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {item.systemServer && <Flag tone="warn">Same server as Synergy&apos;s own database</Flag>}
                    {item.superuser && <Flag tone="danger">Superuser account ({item.username})</Flag>}
                    {item.sharedWithProduction && <Flag tone="warn">Staging uses the production database</Flag>}
                    {item.external && <Flag tone="info">Hosted outside this server</Flag>}
                  </div>
                </div>
                <Button size="sm" onClick={() => void link(item)} disabled={!isAdmin || busy !== null}>{busy === item.projectId + item.source ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}Link</Button>
              </div>
            ))}
          </div>
          {!isAdmin && <p className="border-t border-border px-5 py-2.5 text-xs text-muted-foreground">An administrator can link these databases.</p>}
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input aria-label="Search databases" className="control-input pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search databases, apps, projects or servers…" />
        </div>
      </div>

      {databases === null ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse rounded-lg border border-border bg-card" />)}</div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <Database className="mb-3 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{databases.length ? 'No matching databases' : 'No databases yet'}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">Add one from a project&apos;s Storage tab, or link the ones your apps already use above.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_100px_minmax(0,1fr)_24px] gap-4 border-b border-border px-5 py-2.5 text-xs text-muted-foreground md:grid">
            <span>Database</span><span>Used by</span><span>Size</span><span>Backups</span><span />
          </div>
          <div className="divide-y divide-border">
            {visible.map(database => (
              <Link key={database.key} href={`/storage/${database.id}`} className="grid gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_100px_minmax(0,1fr)_24px] md:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderLogo provider={database.engine} />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-mono text-sm font-medium">{database.database}{database.warnings.length > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-building" aria-label={`${database.warnings.length} warnings`} />}</p>
                    <p className="flex items-center gap-2 truncate text-xs text-muted-foreground">{providerMeta[database.engine]?.label}<span className={cn('rounded-full border px-1.5 py-px text-[10px]', serverRoleLabel[database.serverRole].className)}>{serverRoleLabel[database.serverRole].label}</span></p>
                  </div>
                </div>
                <div className="min-w-0 text-sm">
                  <p className="truncate">{database.apps.map(app => app.name).join(', ')}</p>
                  <p className="truncate text-xs text-muted-foreground">{[...new Set(database.apps.map(app => app.groupName).filter(Boolean))].join(', ') || '—'}</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{formatBytes(database.sizeBytes)}</span>
                <span className="text-xs">
                  {database.backup
                    ? <span className={database.backup.lastStatus === 'failed' ? 'text-status-failed' : 'text-muted-foreground'}>{database.backup.frequency}{database.backup.lastFinishedAt ? ` · last ${relativeTime(database.backup.lastFinishedAt, now)}` : ' · not run yet'}{database.backup.lastStatus === 'failed' ? ' · failed' : ''}</span>
                    : <span className={database.engine === 'postgresql' ? 'text-status-building' : 'text-muted-foreground'}>{database.engine === 'postgresql' ? 'No backups' : 'Managed by the server'}</span>}
                </span>
                <ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" />
              </Link>
            ))}
          </div>
        </div>
      )}
      {atRisk > 0 && <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldAlert className="h-3.5 w-3.5" />Databases marked with a warning sign have a risk worth fixing. Open one to see what and how.</p>}
    </AppShell>
  )
}
