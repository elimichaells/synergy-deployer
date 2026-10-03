'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Database, Loader2, RefreshCw } from 'lucide-react'
import { Section } from '@/components/app/section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Recommendation { key: string; current: string; recommended: string; savingMb: number; measured: boolean; title: string; why: string }
interface Server {
  connectionId: string; name: string; engine: string; port: number; version: string | null; memoryMb: number | null; service: string | null
  dataMb: number | null; databases: number | null; connections: { total: number; idle: number; groups: { login: string; database: string; state: string; count: number }[] } | null
  apps: string[]; recommendations: Recommendation[]; notes: string[]; error: string | null
}
interface TuneResult { ok: boolean; settings: string; before: number | null; after: number | null; log: string[]; apps: string[] }

const gb = (mb: number | null | undefined) => mb === null || mb === undefined ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
const engineName: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }

function ServerCard({ server, canTune, onTuned }: { server: Server; canTune: boolean; onTuned: () => void }) {
  const [chosen, setChosen] = useState<string[]>(() => server.recommendations.map(item => item.key))
  const [tuning, setTuning] = useState(false)
  const [result, setResult] = useState<TuneResult | null>(null)
  const [error, setError] = useState('')
  const saving = server.recommendations.filter(item => chosen.includes(item.key)).reduce((sum, item) => sum + item.savingMb, 0)
  const engine = engineName[server.engine] || server.engine

  const tune = async () => {
    const affected = server.apps.length ? `${server.apps.join(', ')} will lose ${server.apps.length === 1 ? 'its' : 'their'} database connection` : 'Apps using it will lose their database connection'
    if (!window.confirm(`Apply ${chosen.length} change${chosen.length === 1 ? '' : 's'} and restart ${engine}?\n\n${affected} for about 10 to 30 seconds while it restarts. The new settings are checked first, and the old ones are put back if ${engine} does not start.`)) return
    setTuning(true); setError(''); setResult(null)
    try {
      const response = await fetch('/api/server/databases/tune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: server.connectionId, keys: chosen }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not apply the changes')
      setResult(body.result)
      onTuned()
    } catch (err) { setError((err as Error).message) } finally { setTuning(false) }
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium"><Database className="h-4 w-4 text-muted-foreground" />{server.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{engine}{server.version ? ` ${server.version}` : ''} · port {server.port}{server.service ? ` · service ${server.service}` : ''}</p>
        </div>
        <p className="text-right"><span className="block text-xl font-semibold">{gb(server.memoryMb)}</span><span className="text-xs text-muted-foreground">memory now</span></p>
      </div>

      {server.error
        ? <p className="mt-3 text-xs text-amber-200">Could not look inside: {server.error}</p>
        : <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Data</dt><dd className="text-sm">{gb(server.dataMb)} in {server.databases ?? '—'} database{server.databases === 1 ? '' : 's'}</dd></div>
          <div><dt className="text-muted-foreground">Connections</dt><dd className="text-sm">{server.connections ? `${server.connections.total} open, ${server.connections.idle} idle` : '—'}</dd></div>
          <div><dt className="text-muted-foreground">Used by</dt><dd className="text-sm">{server.apps.length ? server.apps.join(', ') : 'No linked apps'}</dd></div>
        </dl>}

      {server.notes.map(note => <p key={note} className="mt-3 flex items-start gap-2 text-xs text-muted-foreground"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-building" />{note}</p>)}

      {server.recommendations.length > 0 && <div className="mt-4 space-y-2">
        <p className="text-sm font-medium">Settings worth changing</p>
        {server.recommendations.map(item => (
          <label key={item.key} className={cn('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm', chosen.includes(item.key) ? 'border-white/25 bg-white/[0.03]' : 'border-border')}>
            <input type="checkbox" className="mt-1" checked={chosen.includes(item.key)} disabled={!canTune || tuning}
              onChange={event => setChosen(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{item.title}</span><span className="text-xs text-status-ready">frees {item.measured ? '' : 'about '}{gb(item.savingMb)}</span></span>
              <span className="block text-xs leading-5 text-muted-foreground">{item.why}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">{item.key}: {item.current} → {item.recommended}</span>
            </span>
          </label>
        ))}
        {canTune
          ? <Button size="sm" disabled={!chosen.length || tuning} onClick={() => void tune()}>
            {tuning ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Applying and restarting…</> : `Apply and restart ${engine}${saving ? `, frees about ${gb(saving)}` : ''}`}
          </Button>
          : <p className="text-xs text-muted-foreground">An administrator can apply these.</p>}
      </div>}

      {!server.error && server.recommendations.length === 0 && server.engine !== 'postgresql' && <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5 text-status-ready" />Memory settings already suit this server.</p>}
      {result && <div role="status" className={cn('mt-3 rounded-md border px-3 py-2 text-xs', result.ok ? 'border-status-ready/30 text-status-ready' : 'border-status-failed/30 text-red-300')}>
        {result.ok ? `Applied and ${engine} is running. Memory before ${gb(result.before)}, now ${gb(result.after)}; it settles over the next minutes.` : 'The change did not complete.'}
        {result.log.length > 0 && <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{result.log.join('\n')}</pre>}
      </div>}
      {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    </div>
  )
}

/** Each database server on this machine, what it holds, and memory settings worth changing. */
export function DatabaseServers() {
  const [servers, setServers] = useState<Server[] | null>(null)
  const [canTune, setCanTune] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setLoading(true)
    void fetch('/api/server/databases', { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read the database servers')
      setServers(body.servers); setCanTune(!!body.canTune); setError('')
    }).catch(err => setError((err as Error).message)).finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])
  const total = (servers ?? []).reduce((sum, server) => sum + (server.memoryMb ?? 0), 0)

  return (
    <Section title="Database servers"
      description={<>One server per engine holds many databases, each with its own login. {servers ? <>Together they use <span className="text-foreground">{gb(total)}</span>.</> : null} Settings changes restart that one server; its apps reconnect when it is back.</>}
      action={<Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Check again</Button>}>
      {error && <p role="alert" className="notice-error">{error}</p>}
      {!servers && !error && <div className="h-32 animate-pulse rounded-lg border border-border" />}
      {servers && servers.length === 0 && <p className="text-sm text-muted-foreground">No database servers on this machine are connected to the manager.</p>}
      {servers && <div className="space-y-3">{servers.map(server => <ServerCard key={server.connectionId} server={server} canTune={canTune} onTuned={load} />)}</div>}
    </Section>
  )
}
