'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Link2, Loader2, Plug, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ProviderLogo, providerMeta } from './providers'

export type Engine = 'postgresql' | 'mysql' | 'mariadb' | 'mongodb' | 'sqlserver' | 'redis'

export interface ServerConnection { id: string; name: string; provider: Engine; host: string; port: number; last_status: string; is_default: boolean; provisioning_enabled: boolean; purpose?: string; options?: { system?: boolean } }
interface Runtime { id: string; installed: boolean; canInstall: boolean; activeJob: { id: string } | null }
interface Job { id: string; status: 'queued' | 'running' | 'success' | 'failed'; log: string; error: string | null }

export const ENGINES: { id: Engine; hint: string; port: number; runtime: string }[] = [
  { id: 'postgresql', hint: 'Relational SQL. The usual choice for Next.js, Node and Go.', port: 5433, runtime: 'postgresql' },
  { id: 'mysql', hint: 'Relational SQL. The Laravel default. Includes phpMyAdmin.', port: 3306, runtime: 'mysql' },
  { id: 'mariadb', hint: 'MySQL-compatible relational SQL.', port: 3306, runtime: 'mariadb' },
  { id: 'mongodb', hint: 'Document database for JSON-shaped data.', port: 27017, runtime: 'mongodb' },
  { id: 'sqlserver', hint: 'Microsoft SQL Server Express.', port: 1433, runtime: 'sqlserver' },
  { id: 'redis', hint: 'In-memory cache, queues and sessions. Connect an existing server.', port: 6379, runtime: 'redis' },
]

type EngineState = { kind: 'ready'; connection: ServerConnection } | { kind: 'untested'; connection: ServerConnection } | { kind: 'installed' } | { kind: 'installable' } | { kind: 'installing'; jobId: string } | { kind: 'external' }

/**
 * Every database engine and what it takes to use it on this server: pick a ready
 * one, test a registered one, connect an installed one, or install it first.
 */
export function ServiceCatalog({ role, selectedConnectionId, onSelect }: {
  role: 'admin' | 'operator' | 'viewer'
  selectedConnectionId?: string
  onSelect: (connection: ServerConnection) => void
}) {
  const [connections, setConnections] = useState<ServerConnection[] | null>(null)
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [job, setJob] = useState<{ engine: Engine; job: Job } | null>(null)
  const [connectFor, setConnectFor] = useState<Engine | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ name: '', host: '127.0.0.1', port: 5433, username: '', password: '', tlsEnabled: false, isDefault: false })
  const poll = useRef<number | null>(null)
  const isAdmin = role === 'admin'

  const load = useCallback(async () => {
    const [connectionRes, runtimeRes] = await Promise.all([fetch('/api/data/connections', { cache: 'no-store' }), fetch('/api/system/runtimes', { cache: 'no-store' })])
    // Synergy's own server and reference-only external servers never receive new databases.
    const loaded: ServerConnection[] = (connectionRes.ok ? (await connectionRes.json()).connections || [] : [])
      .filter((connection: ServerConnection) => connection.options?.system !== true && connection.purpose !== 'external_service')
    setConnections(loaded)
    if (runtimeRes.ok) setRuntimes((await runtimeRes.json()).runtimes || [])
    return loaded
  }, [])

  useEffect(() => { void load().catch(err => setError(err.message)) }, [load])
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current) }, [])

  const watchJob = (engine: Engine, jobId: string) => {
    if (poll.current) window.clearInterval(poll.current)
    poll.current = window.setInterval(async () => {
      const response = await fetch(`/api/system/runtimes/jobs/${jobId}`, { cache: 'no-store' }).catch(() => null)
      if (!response?.ok) return
      const current: Job = (await response.json()).job
      setJob({ engine, job: current })
      if (current.status === 'success' || current.status === 'failed') {
        if (poll.current) window.clearInterval(poll.current)
        poll.current = null
        // MySQL registers its own provisioning account; other engines need their admin login.
        const loaded = await load()
        if (current.status === 'success' && !loaded.some(connection => connection.provider === engine)) openConnect(engine)
      }
    }, 2000)
  }

  const stateOf = (engine: (typeof ENGINES)[number]): EngineState => {
    const registered = (connections || []).filter(connection => connection.provider === engine.id)
    const ready = registered.find(connection => connection.provisioning_enabled && connection.last_status === 'healthy' && connection.is_default)
      || registered.find(connection => connection.provisioning_enabled && connection.last_status === 'healthy')
    if (ready) return { kind: 'ready', connection: ready }
    if (registered[0]) return { kind: 'untested', connection: registered[0] }
    const runtime = runtimes.find(item => item.id === engine.runtime)
    if (job?.engine === engine.id && ['queued', 'running'].includes(job.job.status)) return { kind: 'installing', jobId: job.job.id }
    if (runtime?.activeJob) return { kind: 'installing', jobId: runtime.activeJob.id }
    if (runtime?.installed && engine.id !== 'postgresql') return { kind: 'installed' }
    if (runtime?.canInstall) return { kind: 'installable' }
    return { kind: 'external' }
  }

  const install = async (engine: Engine) => {
    if (!window.confirm(`Install ${providerMeta[engine].label} on this server? It takes a few minutes, is restricted to this machine (no ports are opened), and runs while your apps keep serving.`)) return
    setBusy(engine); setError('')
    try {
      const response = await fetch('/api/system/runtimes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: ENGINES.find(item => item.id === engine)!.runtime, action: 'install' }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Installation could not start')
      setJob({ engine, job: body.job })
      watchJob(engine, body.job.id)
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const test = async (connection: ServerConnection) => {
    setBusy(connection.id); setError('')
    try {
      const response = await fetch(`/api/data/connections/${connection.id}/test`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Connection test failed')
      await load()
    } catch (err) { setError((err as Error).message); await load() } finally { setBusy(null) }
  }

  const openConnect = (engine: Engine) => {
    const definition = ENGINES.find(item => item.id === engine)!
    setForm({ name: `${providerMeta[engine].label} on this server`, host: '127.0.0.1', port: definition.port, username: engine === 'postgresql' ? 'postgres' : engine === 'mysql' || engine === 'mariadb' ? 'root' : engine === 'sqlserver' ? 'sa' : '', password: '', tlsEnabled: false, isDefault: !(connections || []).some(connection => connection.provider === engine) })
    setConnectFor(engine); setError('')
  }

  const connect = async () => {
    if (!connectFor) return
    setBusy('connect'); setError('')
    try {
      const response = await fetch('/api/data/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, provider: connectFor, purpose: 'shared_application', provisioningEnabled: true }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Connection failed')
      setConnectFor(null)
      await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  if (connections === null) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading services" /></div>

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Database engine">
        {ENGINES.map(engine => {
          const state = stateOf(engine)
          const selected = state.kind === 'ready' && state.connection.id === selectedConnectionId
          return (
            <div key={engine.id} className={cn('flex flex-col gap-3 rounded-lg border p-4 transition-colors', selected ? 'border-foreground/70 bg-white/[0.05]' : 'border-border')}>
              <button type="button" role="radio" aria-checked={selected} disabled={state.kind !== 'ready'} onClick={() => state.kind === 'ready' && onSelect(state.connection)} className="flex items-start gap-3 text-left disabled:cursor-default">
                <ProviderLogo provider={engine.id} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{providerMeta[engine.id].label}
                    {state.kind === 'ready' && <span className="flex items-center gap-1 rounded-full bg-status-ready/15 px-1.5 py-px text-[10px] text-emerald-300"><CheckCircle2 className="h-3 w-3" />Ready</span>}
                    {state.kind === 'installing' && <span className="flex items-center gap-1 rounded-full bg-syn-cyan/15 px-1.5 py-px text-[10px] text-cyan-200"><Loader2 className="h-3 w-3 animate-spin" />Installing</span>}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">{engine.hint}</span>
                </span>
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                {state.kind === 'ready' && <><span className="truncate">On {state.connection.name}</span><span className={selected ? 'text-foreground' : ''}>{selected ? 'Selected' : 'Select'}</span></>}
                {state.kind === 'untested' && <><span className="truncate">{state.connection.name} · {state.connection.provisioning_enabled ? state.connection.last_status : 'provisioning off'}</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!isAdmin || busy !== null} onClick={() => void test(state.connection)}>{busy === state.connection.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Test</Button></>}
                {state.kind === 'installed' && <><span>Installed, not connected yet</span><Button size="sm" variant="outline" className="h-7 text-xs" disabled={!isAdmin} onClick={() => openConnect(engine.id)}><Plug className="mr-1 h-3 w-3" />Connect</Button></>}
                {state.kind === 'installable' && <><span>Not on this server yet</span><Button size="sm" className="h-7 text-xs" disabled={!isAdmin || busy !== null || !!job && ['queued', 'running'].includes(job.job.status)} onClick={() => void install(engine.id)}>{busy === engine.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Download className="mr-1 h-3 w-3" />}Install</Button></>}
                {state.kind === 'installing' && <span className="truncate">{job?.engine === engine.id ? job.job.log.trim().split('\n').pop()?.slice(0, 90) || 'Starting…' : 'Another installation is running'}</span>}
                {state.kind === 'external' && <><span>{engine.id === 'postgresql' ? 'Connect your PostgreSQL server' : 'Runs elsewhere; connect it'}</span><Button size="sm" variant="outline" className="h-7 text-xs" disabled={!isAdmin} onClick={() => openConnect(engine.id)}><Link2 className="mr-1 h-3 w-3" />Connect</Button></>}
              </div>
            </div>
          )
        })}
      </div>
      {!isAdmin && <p className="text-xs text-muted-foreground">Only administrators can install or connect database servers.</p>}
      {job?.job.status === 'failed' && <p role="alert" className="rounded-md border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-300">{providerMeta[job.engine].label} installation failed: {job.job.error}</p>}
      {job?.job.status === 'success' && <p role="status" className="rounded-md border border-status-ready/25 bg-status-ready/5 px-3 py-2 text-xs text-emerald-200">{providerMeta[job.engine].label} is installed{(connections || []).some(connection => connection.provider === job.engine) ? ' and ready.' : '. Connect it below with its administrator account.'}</p>}
      {error && <p role="alert" className="rounded-md border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-300">{error}</p>}

      {connectFor && (
        <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); void connect() }}>
          <div className="flex items-center gap-2"><ProviderLogo provider={connectFor} size="sm" /><p className="text-sm font-medium">Connect a {providerMeta[connectFor].label} server</p></div>
          <p className="text-xs text-muted-foreground">Synergy uses this administrator account only to create a separate database and user for each app. The password is stored encrypted.</p>
          <label className="field-label">Name<input className="control-input" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <label className="field-label">Host<input className="control-input font-mono" value={form.host} onChange={event => setForm({ ...form, host: event.target.value })} /></label>
            <label className="field-label">Port<input className="control-input font-mono" type="number" value={form.port} onChange={event => setForm({ ...form, port: Number(event.target.value) })} /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field-label">Admin username<input className="control-input" autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></label>
            <label className="field-label">Admin password<input className="control-input" type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2"><Switch checked={form.isDefault} onCheckedChange={isDefault => setForm({ ...form, isDefault })} />Recommended for new apps</label>
            <label className="flex items-center gap-2"><Switch checked={form.tlsEnabled} onCheckedChange={tlsEnabled => setForm({ ...form, tlsEnabled })} />Use TLS</label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConnectFor(null)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy === 'connect' || !form.name || !form.host}>{busy === 'connect' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1.5 h-3.5 w-3.5" />}Test and connect</Button>
          </div>
        </form>
      )}
    </div>
  )
}
