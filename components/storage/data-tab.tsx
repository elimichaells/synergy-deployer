'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'
import { ResultsGrid, type GridColumn } from './results-grid'

interface TableInfo { schema: string; name: string; est_rows: number; size_bytes: number }
interface Rows { columns: GridColumn[]; rows: Record<string, unknown>[]; total: number; page: number; pageSize: number }

/** Browse a database's tables and their rows. Read-only. */
export function DataTab({ serviceId }: { serviceId: string }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null)
  const [rows, setRows] = useState<Rows | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void fetch(`/api/storage/${serviceId}/data`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read the tables')
      setTables(body.tables)
    }).catch(err => { setError((err as Error).message); setTables([]) })
  }, [serviceId])

  const open = useCallback(async (schema: string, name: string, page = 1) => {
    setSelected({ schema, name }); setLoading(true); setError('')
    try {
      const response = await fetch(`/api/storage/${serviceId}/data/rows?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(name)}&page=${page}&pageSize=50`, { cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read the rows')
      setRows(body)
    } catch (err) { setError((err as Error).message) } finally { setLoading(false) }
  }, [serviceId])

  if (!tables) return <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Reading tables…</div>
  const shown = tables.filter(table => `${table.schema}.${table.name}`.toLowerCase().includes(filter.toLowerCase()))
  const pages = rows ? Math.max(1, Math.ceil(rows.total / rows.pageSize)) : 1

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-2">
        <input aria-label="Filter tables" className="control-input" placeholder={`Filter ${tables.length} tables`} value={filter} onChange={event => setFilter(event.target.value)} />
        <div className="max-h-[520px] space-y-0.5 overflow-y-auto rounded-lg border border-border p-1.5">
          {shown.map(table => {
            const active = selected?.schema === table.schema && selected?.name === table.name
            return <button key={`${table.schema}.${table.name}`} type="button" onClick={() => void open(table.schema, table.name)} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs ${active ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'}`}>
              <Table2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{table.schema === 'public' ? table.name : `${table.schema}.${table.name}`}</span>
              <span className="shrink-0 text-[10px]">{formatBytes(table.size_bytes)}</span>
            </button>
          })}
          {!shown.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{tables.length ? 'No matching tables.' : 'This database has no tables yet.'}</p>}
        </div>
      </div>
      <div className="min-w-0 space-y-3">
        {error && <div role="alert" className="notice-error">{error}</div>}
        {!selected && !error && <p className="rounded-lg border border-dashed border-border px-4 py-16 text-center text-sm text-muted-foreground">Pick a table to see its rows. This view is read-only.</p>}
        {selected && <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm">{selected.schema}.{selected.name}{rows && <span className="ml-2 font-sans text-xs text-muted-foreground">{rows.total.toLocaleString()} rows</span>}</p>
            {rows && <div className="flex items-center gap-2 text-xs text-muted-foreground">Page {rows.page} of {pages}
              <Button variant="outline" size="sm" disabled={loading || rows.page <= 1} onClick={() => void open(selected.schema, selected.name, rows.page - 1)} aria-label="Previous page"><ChevronLeft className="h-3.5 w-3.5" /></Button>
              <Button variant="outline" size="sm" disabled={loading || rows.page >= pages} onClick={() => void open(selected.schema, selected.name, rows.page + 1)} aria-label="Next page"><ChevronRight className="h-3.5 w-3.5" /></Button>
            </div>}
          </div>
          {loading ? <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading rows…</div> : rows && <ResultsGrid columns={rows.columns} rows={rows.rows} />}
        </>}
      </div>
    </div>
  )
}
