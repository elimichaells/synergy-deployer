'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, Lock, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProviderLogo, type Provider } from '@/components/app/providers'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Flag, serverRoleLabel } from './bits'

interface Engine {
  id: string; name: string; engine: Provider; host: string; port: number; role: 'system' | 'apps' | 'external'; provisioning: boolean; status: string; version: string | null
  listen: string | null; localOnly: boolean | null; remoteRules: number | null; ssl: boolean | null; pendingRestart: boolean
  databaseCount: number | null; sizeBytes: number | null; linkedCount: number; warnings: string[]
}

const roleHelp: Record<string, string> = {
  system: 'Holds Synergy\'s own data. New app databases are never created here.',
  apps: 'Where Synergy creates app databases, each with its own user.',
  external: 'Hosted elsewhere. Synergy only tracks databases on it.',
}

/** Each database server: what it's for, how exposed it is, and what lives on it. */
export function EnginesPanel() {
  const [engines, setEngines] = useState<Engine[] | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/storage/engines', { cache: 'no-store' })
    if (!response.ok) { setEngines([]); return }
    const body = await response.json()
    setEngines(body.engines); setIsAdmin(body.isAdmin)
  }, [])
  useEffect(() => { void load() }, [load])

  const restrict = async (engine: Engine) => {
    if (!window.confirm(`Limit ${engine.name} to connections from this machine?\n\nApps on this server keep working. The change takes effect the next time the PostgreSQL service restarts; Synergy does not restart it for you.`)) return
    setBusy(engine.id); setMessage(null)
    try {
      const response = await fetch(`/api/storage/engines/${engine.id}/restrict`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The setting could not be changed')
      setMessage({ tone: 'ok', text: `Saved. Restart the PostgreSQL Windows service at a quiet moment to apply it: every app on ${engine.name} (and Synergy, if it's the system server) disconnects for a few seconds and reconnects.` })
      await load()
    } catch (error) { setMessage({ tone: 'error', text: (error as Error).message }) } finally { setBusy(null) }
  }

  if (engines === null) return <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
  if (!engines.length) return null

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Servers at a glance</h2>
        <p className="text-xs text-muted-foreground">What each database server is for, who can reach it, and what lives on it.</p>
      </div>
      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={cn('rounded-md border px-3 py-2 text-sm', message.tone === 'error' ? 'border-red-400/25 bg-red-400/5 text-red-300' : 'border-status-ready/25 bg-status-ready/5 text-emerald-200')}>{message.text}</p>}
      <div className="grid gap-3 xl:grid-cols-2">
        {engines.map(engine => (
          <div key={engine.id} className={cn('rounded-xl border bg-card p-4', engine.warnings.length ? 'border-status-building/30' : 'border-border')}>
            <div className="flex items-start gap-3">
              <ProviderLogo provider={engine.engine} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{engine.name}<span className={cn('rounded-full border px-2 py-px text-[10px] font-normal', serverRoleLabel[engine.role].className)}>{serverRoleLabel[engine.role].label}</span></p>
                <p className="truncate font-mono text-xs text-muted-foreground">{engine.host}:{engine.port}{engine.version ? ` · ${engine.version}` : ''}</p>
                <p className="mt-1 text-xs text-muted-foreground">{roleHelp[engine.role]}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {engine.localOnly !== null && <Flag tone={engine.localOnly ? 'info' : 'warn'}>{engine.localOnly ? 'This machine only' : `Listens on ${engine.listen === '*' ? 'every network interface' : engine.listen}`}{engine.pendingRestart ? ' · change waits for a restart' : ''}</Flag>}
              {engine.remoteRules !== null && <Flag tone={engine.remoteRules ? 'warn' : 'info'}>{engine.remoteRules ? `${engine.remoteRules} remote sign-in rule(s)` : 'Remote sign-ins refused'}</Flag>}
              {engine.ssl !== null && <Flag tone={engine.ssl ? 'info' : 'warn'}>{engine.ssl ? 'TLS available' : 'TLS off'}</Flag>}
              {engine.databaseCount !== null && <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">{engine.databaseCount} databases · {formatBytes(engine.sizeBytes)} · {engine.linkedCount} tracked</span>}
            </div>
            {engine.warnings.length > 0 && <ul className="mt-3 space-y-1">{engine.warnings.map(warning => <li key={warning} className="flex items-start gap-1.5 text-xs text-amber-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{warning}</li>)}</ul>}
            {isAdmin && engine.engine === 'postgresql' && engine.role !== 'external' && engine.localOnly === false && !engine.pendingRestart && (
              <div className="mt-3 border-t border-border pt-3">
                <Button size="sm" variant="outline" onClick={() => void restrict(engine)} disabled={busy !== null}>{busy === engine.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Lock className="mr-1.5 h-3.5 w-3.5" />}Restrict to this machine</Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-border p-4 text-xs leading-5 text-muted-foreground">
        <Network className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
        <p><span className="font-medium text-foreground">Remote access, the safe way.</span> Keep database ports closed to the internet; apps on this server don&apos;t need them open. To reach a database from your own computer, use an SSH tunnel or a private network (Tailscale, WireGuard). Opening a port directly should be limited to specific IP addresses, require TLS and use a per-app user, never a superuser.</p>
      </div>
    </section>
  )
}
