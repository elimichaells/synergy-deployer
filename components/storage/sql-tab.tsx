'use client'

import { useState } from 'react'
import { Loader2, Lock, Play, Unlock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResultsGrid, type GridColumn } from './results-grid'

interface SqlResult { command: string; rowCount: number; columns: GridColumn[]; rows: Record<string, unknown>[]; truncated: boolean; durationMs: number }

/** Run SQL against one database. Read-only until writes are switched on; writes are audited. */
export function SqlTab({ serviceId, database }: { serviceId: string; database: string }) {
  const [sql, setSql] = useState('')
  const [allowWrites, setAllowWrites] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState('')

  const run = async () => {
    if (running || !sql.trim()) return
    setRunning(true); setError(''); setResult(null)
    try {
      const response = await fetch(`/api/storage/${serviceId}/data/sql`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, allowWrites }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The query failed')
      setResult(body)
    } catch (err) { setError((err as Error).message) } finally { setRunning(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Runs against <span className="font-mono text-foreground">{database}</span>. Press Ctrl+Enter to run.</p>
        <button type="button" onClick={() => setAllowWrites(value => !value)} className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${allowWrites ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-400'}`}
          title={allowWrites ? 'Queries can change data. Each one is recorded in the audit log.' : 'Read-only: any change is blocked'}>
          {allowWrites ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{allowWrites ? 'Writes enabled' : 'Read-only'}
        </button>
      </div>
      <textarea aria-label="SQL" className="h-40 w-full resize-y rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60" value={sql} onChange={event => setSql(event.target.value)} placeholder="select * from users limit 10;" spellCheck={false}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void run() } }} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{result && <><span className="font-semibold text-emerald-400">{result.command}</span> · {result.rowCount.toLocaleString()} rows · {result.durationMs}ms{result.truncated && <span className="text-amber-400"> · showing the first 1,000</span>}</>}</p>
        <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()}>{running ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}{running ? 'Running…' : 'Run query'}</Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 font-mono text-xs text-red-400">{error}</div>}
      {result && result.columns.length > 0 && <div className="max-h-[480px] overflow-auto"><ResultsGrid columns={result.columns} rows={result.rows} /></div>}
    </div>
  )
}
