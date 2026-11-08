import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Search } from 'lucide-react'

export function RuntimeInventoryRow({ installed, name, description, badges, detail, actions }: { installed: boolean; name: string; description: string; badges?: ReactNode; detail?: ReactNode; actions?: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-4 py-4"><div className="min-w-0 flex-1 basis-56"><div className="flex flex-wrap items-center gap-2 text-sm font-medium">{installed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}{name}{badges}</div><p className="mt-1 break-words pl-6 text-xs text-muted-foreground">{description}</p>{detail}</div><div className="flex max-w-full flex-wrap items-center gap-1">{actions}</div></div>
}

export function RuntimeFilters({ search, category, status, onSearch, onCategory, onStatus, updates = true }: {
  search: string; category: string; status: string; onSearch: (value: string) => void; onCategory: (value: string) => void; onStatus: (value: string) => void; updates?: boolean
}) {
  return <div className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_160px_150px]">
    <div className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search runtimes" className="control-input pl-9" placeholder="Search dependencies" value={search} onChange={event => onSearch(event.target.value)} /></div>
    <select aria-label="Runtime category" className="control-input" value={category} onChange={event => onCategory(event.target.value)}><option value="all">All categories</option><option value="languages">Languages & build</option><option value="databases">Databases</option><option value="tools">Host tools</option></select>
    <select aria-label="Runtime status" className="control-input" value={status} onChange={event => onStatus(event.target.value)}><option value="all">All statuses</option><option value="installed">Installed</option><option value="missing">Not installed</option>{updates && <option value="updates">Updates available</option>}</select>
  </div>
}
