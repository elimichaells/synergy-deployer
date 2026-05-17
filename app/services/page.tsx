'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AppShell } from '@/components/layout/app-shell'
import {
  Activity,
  CheckCircle2,
  XCircle,
  PlayCircle,
  Clock,
  Search,
  Timer,
  Terminal,
  Calendar,
  Filter,
  ArrowRight,
  GitBranch,
  GitCommit,
  Cpu,
  Zap,
  RotateCcw,
  Power,
  Server,
  Globe,
  RefreshCw
} from 'lucide-react'

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

interface Service {
  id: string
  name: string
  displayName: string
  status: 'online' | 'stopped' | 'errored'
  uptime: number | null
  cpu: number
  memory: number
  restarts: number
  url: string | null
  port: number | null
}

interface CaddyInfo {
  mode: 'pm2' | 'service' | 'cli' | 'unknown'
  status: string
  configPath: string
  version?: string
}

function formatUptime(ms: number | null): string {
  if (!ms) return '—'
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export default function ServicesPage() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [services, setServices] = useState<Service[]>([])
  const [caddy, setCaddy] = useState<CaddyInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [caddyBusy, setCaddyBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const canControl = user?.role === 'admin' || user?.role === 'operator'

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [meRes, servicesRes, caddyRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/services'),
        fetch('/api/system/caddy'),
      ])

      const meData = meRes.ok ? await meRes.json() : { user: null }
      setUser(meData.user)

      if (!servicesRes.ok) throw new Error('Failed to load services')
      setServices(await servicesRes.json())

      if (caddyRes.ok) setCaddy(await caddyRes.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const handleServiceAction = async (id: string, action: string) => {
    setActionBusy(`${id}-${action}`)
    setOutput(null)
    try {
      const res = await fetch(`/api/services/${id}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to ${action}`)
      setOutput(data.message || 'OK')
      await refresh()
    } catch (err) {
      setOutput(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionBusy(null)
    }
  }

  const handleCaddyAction = async (action: string) => {
    setCaddyBusy(true)
    setOutput(null)
    try {
      const res = await fetch('/api/system/caddy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to ${action}`)
      setOutput(data.output || 'OK')
      await refresh()
    } catch (err) {
      setOutput(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setCaddyBusy(false)
    }
  }

  const filteredServices = useMemo(() => {
    if (!searchQuery) return services
    const q = searchQuery.toLowerCase()
    return services.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.displayName.toLowerCase().includes(q)
    )
  }, [services, searchQuery])

  const onlineCount = services.filter((s) => s.status === 'online').length
  const caddyUp = caddy?.status === 'running'

  return (
    <AppShell
      title="Services"
      subtitle="Manage running processes and infrastructure."
      user={{ name: user?.name, role: user?.role }}
      actions={
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search services..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-64 rounded-lg bg-secondary/50 pl-9 pr-4 text-sm outline-none focus:ring-1 focus:ring-primary/50 transition-all"
            />
          </div>
          <button
            onClick={() => refresh()}
            className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Site Processes</span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{services.length}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Cpu className="h-3 w-3" /> System managed
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Online</span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-emerald-500">{onlineCount}</span>
            <span className="text-sm font-medium text-muted-foreground">/ {services.length}</span>
          </div>
          <div className="w-full bg-secondary h-1 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${(onlineCount / (services.length || 1)) * 100}%` }} />
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Stopped / Errored</span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-amber-400">{services.length - onlineCount}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Activity className="h-3 w-3 text-amber-400" /> Attention needed
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Caddy Server</span>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold ${caddyUp ? 'text-emerald-500' : 'text-red-400'}`}>
              {caddyUp ? 'Running' : 'Stopped'}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Globe className="h-3 w-3" /> Port 443
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* Services Table */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Terminal className="h-4 w-4" /> Process List
          </h3>

          <div className="space-y-2">
            {/* Header */}
            <div className="hidden md:grid grid-cols-[2fr_120px_1fr_1fr_1fr_100px_140px] gap-4 px-6 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
              <div>Service</div>
              <div>Status</div>
              <div>Uptime</div>
              <div>CPU</div>
              <div>Memory</div>
              <div>Restarts</div>
              <div className="text-right">Actions</div>
            </div>

            {filteredServices.length === 0 ? (
              <div className="py-20 text-center border-2 border-dashed border-border rounded-3xl opacity-50 flex flex-col items-center justify-center">
                <Search className="h-10 w-10 mb-4 opacity-20" />
                <p className="text-sm font-medium">No services found.</p>
              </div>
            ) : (
              filteredServices.map(svc => (
                <div
                  key={svc.id}
                  className="group relative grid grid-cols-1 md:grid-cols-[2fr_120px_1fr_1fr_1fr_100px_140px] items-center gap-4 rounded-xl border border-border/40 bg-card/30 p-4 transition-all hover:border-primary/30 hover:bg-card/60 hover:shadow-lg hover:shadow-black/20"
                >
                  {/* Service Name */}
                  <div className="flex flex-col min-w-0">
                    <Link
                      href={`/sites/${svc.id}`}
                      className="font-bold text-sm hover:text-primary transition-colors truncate"
                    >
                      {svc.displayName}
                    </Link>
                    <span className="text-[10px] font-mono text-muted-foreground truncate">{svc.name}</span>
                  </div>

                  {/* Status */}
                  <div>
                    <Badge variant="outline" className={`text-[10px] uppercase font-bold px-2 py-0 h-5 border-none flex w-fit items-center gap-1.5 ${svc.status === 'online' ? 'text-emerald-400 bg-emerald-400/10' :
                        svc.status === 'errored' ? 'text-red-400 bg-red-400/10' :
                          'text-muted-foreground bg-secondary'
                      }`}>
                      {svc.status === 'online' && <CheckCircle2 className="h-3 w-3" />}
                      {svc.status === 'errored' && <XCircle className="h-3 w-3" />}
                      {svc.status === 'stopped' && <Power className="h-3 w-3" />}
                      {svc.status}
                    </Badge>
                  </div>

                  {/* Uptime */}
                  <div className="text-xs font-mono text-muted-foreground truncate">
                    {formatUptime(svc.uptime)}
                  </div>

                  {/* CPU */}
                  <div className="text-xs font-mono text-muted-foreground">
                    {svc.cpu}%
                  </div>

                  {/* Memory */}
                  <div className="text-xs font-mono text-muted-foreground">
                    {svc.memory} MB
                  </div>

                  {/* Restarts */}
                  <div className="text-xs font-mono text-muted-foreground">
                    {svc.restarts}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {canControl && (
                      <>
                        {svc.status !== 'online' ? (
                          <button
                            onClick={() => handleServiceAction(svc.id, 'start')}
                            disabled={!!actionBusy}
                            className="h-7 w-7 flex items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50"
                            title="Start"
                          >
                            <PlayCircle className="h-4 w-4" />
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => handleServiceAction(svc.id, 'restart')}
                              disabled={!!actionBusy}
                              className="h-7 w-7 flex items-center justify-center rounded-lg bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground transition-all disabled:opacity-50"
                              title="Restart"
                            >
                              <RotateCcw className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleServiceAction(svc.id, 'stop')}
                              disabled={!!actionBusy}
                              className="h-7 w-7 flex items-center justify-center rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all disabled:opacity-50"
                              title="Stop"
                            >
                              <Power className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Caddy Section */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Globe className="h-4 w-4" /> Infrastructure
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-[2fr_120px_1fr_1fr_1fr_100px_140px] items-center gap-4 rounded-xl border border-border bg-card/10 p-4">
            <div className="flex flex-col">
              <span className="font-bold text-sm">Caddy Server</span>
              <span className="text-[10px] font-mono text-muted-foreground">
                {caddy?.mode !== 'unknown' ? `Mode: ${caddy?.mode}` : ''}{caddy?.version ? ` · ${caddy.version}` : ''}
              </span>
            </div>

            <div>
              <Badge variant="outline" className={`text-[10px] uppercase font-bold px-2 py-0 h-5 border-none flex w-fit items-center gap-1.5 ${caddyUp ? 'text-emerald-400 bg-emerald-400/10' : 'text-muted-foreground bg-secondary'
                }`}>
                {caddyUp ? <CheckCircle2 className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                {caddy?.status || 'unknown'}
              </Badge>
            </div>

            <div className="text-xs font-mono text-muted-foreground col-span-4 pl-2">
              {caddy?.configPath && `Config: ${caddy.configPath}`}
            </div>

            <div className="flex items-center justify-end gap-2">
              {canControl && (
                <>
                  {!caddyUp ? (
                    <button
                      onClick={() => handleCaddyAction('start')}
                      disabled={caddyBusy}
                      className="h-7 w-7 flex items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-white transition-all disabled:opacity-50"
                      title="Start"
                    >
                      <PlayCircle className="h-4 w-4" />
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => handleCaddyAction('reload')}
                        disabled={caddyBusy}
                        className="h-7 w-7 flex items-center justify-center rounded-lg bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground transition-all disabled:opacity-50"
                        title="Reload Config"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleCaddyAction('restart')}
                        disabled={caddyBusy}
                        className="h-7 w-7 flex items-center justify-center rounded-lg bg-secondary text-foreground hover:bg-primary hover:text-primary-foreground transition-all disabled:opacity-50"
                        title="Restart"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleCaddyAction('stop')}
                        disabled={caddyBusy}
                        className="h-7 w-7 flex items-center justify-center rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all disabled:opacity-50"
                        title="Stop"
                      >
                        <Power className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {output && (
            <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-card/20 p-3 text-[11px] font-mono text-foreground/80">
              {output}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}
