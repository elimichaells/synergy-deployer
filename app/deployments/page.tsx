'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { watchDeployment } from '@/lib/deployment-watch'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
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
  RefreshCw,
  Radio,
  ExternalLink
} from 'lucide-react'

interface Deployment {
  id: string
  project_id: string
  project_name: string
  status: 'queued' | 'running' | 'success' | 'failed'
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
  trigger?: string | null
  user_name?: string | null
  log?: string | null
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [selected, setSelected] = useState<Deployment | null>(null)
  const [log, setLog] = useState('')
  const [loadingLog, setLoadingLog] = useState(false)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const streamRef = useRef<{ close(): void } | null>(null)

  const loadDeployments = useCallback(async (silent = false) => {
    if (!silent) setError(null)
    try {
      const deploymentsRes = await fetch('/api/deployments', { cache: 'no-store' })
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')
      const deploymentsData = await deploymentsRes.json()
      setDeployments(deploymentsData)
      setSelected((current) => {
        if (!current) return current
        return deploymentsData.find((deployment: Deployment) => deployment.id === current.id) || current
      })
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load deployments')
    }
  }, [])

  useEffect(() => {
    void loadDeployments()
    void fetch('/api/auth/me')
      .then((response) => response.ok ? response.json() : { user: null })
      .then((data) => setUser(data.user))

    const refreshTimer = window.setInterval(() => void loadDeployments(true), 5_000)
    return () => window.clearInterval(refreshTimer)
  }, [loadDeployments])

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(clock)
  }, [])

  useEffect(() => () => streamRef.current?.close(), [])

  const handleSelect = (deployment: Deployment) => {
    streamRef.current?.close()
    streamRef.current = null
    setSelected(deployment)
    setLoadingLog(true)
    setLog('')
    streamRef.current = watchDeployment<Deployment>(deployment.id, data => {
      setSelected(current => current?.id === data.id ? data : current)
      setLog(data.log || '')
      setLoadingLog(false)
      setDeployments(current => current.map(item => item.id === data.id ? { ...item, ...data } : item))
    }, () => setLoadingLog(false))
  }

  const closeDetails = () => {
    streamRef.current?.close()
    streamRef.current = null
    setSelected(null)
  }

  const filteredDeployments = useMemo(() => {
    return deployments.filter(d => {
      const matchesSearch =
        d.project_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (d.branch && d.branch.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (d.commit_sha && d.commit_sha.toLowerCase().includes(searchQuery.toLowerCase()))

      const matchesStatus = statusFilter === 'active'
        ? d.status === 'running' || d.status === 'queued'
        : statusFilter ? d.status === statusFilter : true

      return matchesSearch && matchesStatus
    })
  }, [deployments, searchQuery, statusFilter])

  const activeDeployments = useMemo(
    () => deployments.filter((deployment) => deployment.status === 'running' || deployment.status === 'queued'),
    [deployments]
  )

  const stats = useMemo(() => {
    const initial = { total: 0, success: 0, failed: 0, running: 0, queued: 0 }
    return deployments.reduce((acc, deployment) => {
      acc.total += 1
      acc[deployment.status] += 1
      return acc
    }, initial)
  }, [deployments])

  const formatDuration = (start: string | null, end: string | null) => {
    if (!start || !end) return '—'
    const duration = new Date(end).getTime() - new Date(start).getTime()
    const seconds = Math.floor(duration / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s`
  }

  const formatElapsed = (start: string | null) => {
    if (!start) return 'Waiting to start'
    const seconds = Math.max(0, Math.floor((now - new Date(start).getTime()) / 1000))
    if (seconds < 60) return `${seconds}s elapsed`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${seconds % 60}s elapsed`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes % 60}m elapsed`
  }

  const renderLogLines = (text: string) => {
    const lines = text.split(/\r?\n/)
    return lines.map((line, index) => {
      const lower = line.toLowerCase()
      let className = 'text-muted-foreground'
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception')) {
        className = 'text-red-400 font-medium'
      } else if (lower.includes('warn')) {
        className = 'text-amber-400'
      } else if (lower.includes('info')) {
        className = 'text-blue-400'
      } else if (lower.includes('debug') || lower.includes('trace')) {
        className = 'text-muted-foreground/60'
      } else if (lower.includes('success') || lower.includes('completed')) {
        className = 'text-emerald-400'
      }
      return (
        <div key={`${index}-${line.slice(0, 12)}`} className={className}>
          {line || ' '}
        </div>
      )
    })
  }

  return (
    <AppShell
      title="Deployments"
      subtitle="Audit deployment history and logs."
      user={{ name: user?.name, role: user?.role }}
      actions={
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search by name, branch, sha..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-64 rounded-lg bg-secondary/50 pl-9 pr-4 text-sm outline-none focus:ring-1 focus:ring-primary/50 transition-all"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-secondary/50 p-1">
            {['all', 'active', 'success', 'failed'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s === 'all' ? null : s)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${(s === 'all' && !statusFilter) || statusFilter === s
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                  }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="space-y-8">
        <section className="border-y border-border/60 bg-card/20">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Radio className={`h-4 w-4 ${activeDeployments.length ? 'text-blue-400 animate-pulse' : 'text-muted-foreground'}`} />
              <h2 className="text-sm font-semibold">Active deployments</h2>
              <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px]">
                {activeDeployments.length}
              </Badge>
            </div>
            <button
              type="button"
              onClick={() => void loadDeployments()}
              className="inline-flex h-8 items-center gap-2 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>

          {activeDeployments.length === 0 ? (
            <div className="px-5 py-5 text-sm text-muted-foreground">No deployment is currently running or queued.</div>
          ) : (
            <div className="divide-y divide-border/40">
              {activeDeployments.map((deployment) => (
                <div key={deployment.id} className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] md:items-center">
                  <button type="button" onClick={() => void handleSelect(deployment)} className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${deployment.status === 'running' ? 'bg-blue-400 animate-pulse' : 'bg-amber-400'}`} />
                      <span className="truncate text-sm font-semibold">{deployment.project_name}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><GitBranch className="h-3 w-3" />{deployment.branch || '—'}</span>
                      <span className="font-mono">{deployment.commit_sha?.slice(0, 7) || 'HEAD'}</span>
                      {deployment.trigger && <span className="capitalize">{deployment.trigger}</span>}
                    </div>
                  </button>
                  <div>
                    <div className="text-xs font-medium text-foreground">{deployment.status === 'running' ? 'Deploying now' : 'Queued'}</div>
                    <div className="mt-1 text-xs font-mono text-muted-foreground">{formatElapsed(deployment.started_at)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSelect(deployment)}
                      className="inline-flex h-8 items-center gap-2 border border-border px-3 text-xs font-medium transition-colors hover:bg-secondary"
                    >
                      <Terminal className="h-3.5 w-3.5" /> Live logs
                    </button>
                    <Link
                      href={`/sites/${deployment.project_id}`}
                      title="Open project"
                      className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="surface-card p-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Total Deployments</span>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{stats.total}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Activity className="h-3 w-3" /> All time history
            </div>
          </div>
          <div className="surface-card p-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Success Rate</span>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-emerald-500">
                {stats.total ? Math.round((stats.success / stats.total) * 100) : 0}%
              </span>
            </div>
            <div className="w-full bg-secondary h-1 rounded-full mt-2 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${stats.total ? (stats.success / stats.total) * 100 : 0}%` }} />
            </div>
          </div>
          <div className="surface-card p-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Active Pipelines</span>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-blue-400">{stats.running}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <PlayCircle className="h-3 w-3 text-blue-400" /> Currently executing
            </div>
          </div>
          <div className="surface-card p-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Queued</span>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-amber-400">{stats.queued}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3 text-amber-400" /> Waiting to start
            </div>
          </div>
        </div>

        {/* Deployments Table */}
        <div className="space-y-4">
          {/* Header */}
          <div className="hidden md:grid grid-cols-[1.5fr_1fr_1.5fr_1fr_1fr_40px] gap-4 px-6 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <div>Application</div>
            <div>Status</div>
            <div>Commit</div>
            <div>Duration</div>
            <div>Date</div>
            <div></div>
          </div>

          <div className="space-y-2">
            {filteredDeployments.length === 0 ? (
              <div className="py-20 text-center border-2 border-dashed border-border rounded-3xl opacity-50 flex flex-col items-center justify-center">
                <Filter className="h-10 w-10 mb-4 opacity-20" />
                <p className="text-sm font-medium">No deployments found.</p>
              </div>
            ) : (
              filteredDeployments.map(deploy => (
                <div
                  key={deploy.id}
                  onClick={() => handleSelect(deploy)}
                  className="group relative grid grid-cols-1 md:grid-cols-[1.5fr_1fr_1.5fr_1fr_1fr_40px] items-center gap-4 rounded-xl border border-border/40 bg-card/30 p-4 transition-all hover:border-primary/30 hover:bg-card/60 hover:shadow-lg hover:shadow-black/20 cursor-pointer"
                >
                  {/* Application */}
                  <div className="font-bold text-sm truncate">{deploy.project_name}</div>

                  {/* Status */}
                  <div>
                    <Badge variant="outline" className={`text-[10px] uppercase font-bold px-2 py-0 h-5 border-none flex w-fit items-center gap-1.5 ${deploy.status === 'success' ? 'text-emerald-400 bg-emerald-400/10' :
                        deploy.status === 'failed' ? 'text-red-400 bg-red-400/10' :
                          deploy.status === 'running' ? 'text-blue-400 bg-blue-400/10 animate-pulse' :
                            'text-muted-foreground bg-secondary'
                      }`}>
                      {deploy.status === 'success' && <CheckCircle2 className="h-3 w-3" />}
                      {deploy.status === 'failed' && <XCircle className="h-3 w-3" />}
                      {deploy.status === 'running' && <PlayCircle className="h-3 w-3" />}
                      {deploy.status === 'queued' && <Clock className="h-3 w-3" />}
                      {deploy.status}
                    </Badge>
                  </div>

                  {/* Commit */}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground min-w-0">
                    <div className="flex items-center gap-1.5 text-foreground/80 font-medium bg-secondary/50 px-2 py-0.5 rounded">
                      <GitBranch className="h-3 w-3 opacity-70" />
                      <span className="truncate max-w-[100px]">{deploy.branch || '—'}</span>
                    </div>
                    <span className="font-mono opacity-50">{deploy.commit_sha?.slice(0, 7) || 'HEAD'}</span>
                  </div>

                  {/* Duration */}
                  <div className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
                    <Timer className="h-3.5 w-3.5 opacity-50" />
                    {deploy.status === 'running' ? 'Running...' : formatDuration(deploy.started_at, deploy.finished_at)}
                  </div>

                  {/* Date */}
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5 opacity-50" />
                    {deploy.finished_at ? new Date(deploy.finished_at).toLocaleDateString() : '—'}
                  </div>

                  {/* Action */}
                  <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Details Sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && closeDetails()}>
        <SheetContent className="sm:max-w-2xl w-full flex flex-col h-full p-0 border-l border-border/50 bg-black/30">
          {selected && (
            <>
              <SheetHeader className="p-6 border-b border-border/40 bg-card/20">
                <div className="flex items-center gap-3 mb-2">
                  <Badge variant="outline" className={`text-[10px] uppercase font-bold px-2 h-5 border-none ${selected.status === 'success' ? 'text-emerald-400 bg-emerald-400/10' :
                      selected.status === 'failed' ? 'text-red-400 bg-red-400/10' :
                        'text-blue-400 bg-blue-400/10'
                    }`}>
                    {selected.status}
                  </Badge>
                  <span className="text-xs font-mono text-muted-foreground">{selected.id.slice(0, 8)}</span>
                </div>
                <SheetTitle className="text-xl">{selected.project_name}</SheetTitle>
                <SheetDescription className="flex items-center gap-4 text-xs mt-2">
                  <span className="flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" /> {selected.branch || '—'}</span>
                  <span className="flex items-center gap-1.5"><GitCommit className="h-3.5 w-3.5" /> {selected.commit_sha?.slice(0, 7)}</span>
                  <span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> {selected.finished_at ? new Date(selected.finished_at).toLocaleString() : formatElapsed(selected.started_at)}</span>
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 overflow-auto p-4 font-mono text-xs">
                {loadingLog ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground gap-2">
                    <Activity className="h-4 w-4 animate-spin" /> Loading logs...
                  </div>
                ) : log ? (
                  <div className="space-y-0.5">
                    {renderLogLines(log)}
                    {selected.status === 'running' && (
                      <div className="mt-3 flex items-center gap-2 text-blue-400">
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Following live output
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 opacity-50">
                    <Terminal className="h-8 w-8" />
                    <p>No logs available for this deployment.</p>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </AppShell>
  )
}
