import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { ProviderLogo, providerMeta, type Provider } from '@/components/app/providers'

export interface DatabaseListRow {
  id: string; href: string; database: string; engine: Provider; server?: ReactNode; applications: string; detail?: string; size: string; backup: ReactNode; warnings?: number
}

export function DatabaseList({ rows }: { rows: DatabaseListRow[] }) {
  return <div className="overflow-hidden rounded-xl border border-border bg-card">
    <div className="hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_100px_minmax(0,1fr)_24px] gap-4 border-b border-border px-5 py-2.5 text-xs text-muted-foreground md:grid"><span>Database</span><span>Used by</span><span>Size</span><span>Backups</span><span /></div>
    <div className="divide-y divide-border">{rows.map(row => <Link key={row.id} href={row.href} className="grid gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_100px_minmax(0,1fr)_24px] md:items-center">
      <div className="flex min-w-0 items-center gap-3"><ProviderLogo provider={row.engine} /><div className="min-w-0"><p className="flex items-center gap-2 truncate font-mono text-sm font-medium">{row.database}{!!row.warnings && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-status-building" aria-label={`${row.warnings} warnings`} />}</p><p className="flex items-center gap-2 truncate text-xs text-muted-foreground">{providerMeta[row.engine]?.label}{row.server}</p></div></div>
      <div className="min-w-0 text-sm"><p className="truncate">{row.applications}</p><p className="truncate text-xs text-muted-foreground">{row.detail || '—'}</p></div>
      <span className="font-mono text-xs text-muted-foreground">{row.size}</span><span className="text-xs">{row.backup}</span><ArrowRight className="hidden h-4 w-4 text-muted-foreground md:block" />
    </Link>)}</div>
  </div>
}
