'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, Rocket, Search } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { DeploymentRow, type DeploymentSummary } from '@/components/synergy/deployment-row'
import { deploymentDuration, formatSeconds } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

const statusFilters = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Building' },
  { value: 'success', label: 'Ready' },
  { value: 'failed', label: 'Error' },
]

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [now, setNow] = useState(() => Date.now())

  const loadDeployments = useCallback(async (silent = false) => {
    if (!silent) setError(null)
    try {
      const response = await fetch('/api/deployments?limit=100', { cache: 'no-store' })
      if (!response.ok) throw new Error('Failed to load deployments')
      setDeployments(await response.json())
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load deployments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDeployments()
    void fetch('/api/auth/me')
      .then((response) => response.ok ? response.json() : { user: null })
      .then((data) => setUser(data.user))
    const refreshTimer = window.setInterval(() => { if (!document.hidden) void loadDeployments(true) }, 5_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clock) }
  }, [loadDeployments])

  const projects = useMemo(() => [...new Map(deployments.map(d => [d.project_id, d.project_name || d.project_id])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [deployments])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return deployments.filter(d => {
      const matchesSearch = !q || [d.project_name, d.branch, d.commit_sha, d.id, d.user_name, d.trigger].some(value => value?.toLowerCase().includes(q))
      const matchesStatus = statusFilter === 'all' ? true : statusFilter === 'active' ? d.status === 'running' || d.status === 'queued' : d.status === statusFilter
      const matchesProject = projectFilter === 'all' || d.project_id === projectFilter
      return matchesSearch && matchesStatus && matchesProject
    })
  }, [deployments, searchQuery, statusFilter, projectFilter])

  const stats = useMemo(() => {
    const finished = deployments.filter(d => d.status === 'success' || d.status === 'failed')
    const success = finished.filter(d => d.status === 'success')
    const durations = success.map(d => deploymentDuration(d.started_at, d.finished_at)).filter((value): value is number => value !== null).sort((a, b) => a - b)
    return {
      total: deployments.length,
      successRate: finished.length ? Math.round((success.length / finished.length) * 100) : null,
      median: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      building: deployments.filter(d => d.status === 'running' || d.status === 'queued').length,
    }
  }, [deployments])

  return (
    <AppShell
      title="Deployments"
      subtitle="Every release across this host, with its full pipeline and build output."
      user={{ name: user?.name, role: user?.role }}
      actions={<Button variant="outline" size="sm" onClick={() => void loadDeployments()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</Button>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      <div className="mb-6 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-4">
        {[
          ['Deployments', String(stats.total), 'loaded history'],
          ['Success rate', stats.successRate === null ? '—' : `${stats.successRate}%`, 'of finished releases'],
          ['Median build', formatSeconds(stats.median), 'successful releases'],
          ['Building now', String(stats.building), stats.building ? 'pipelines in flight' : 'all quiet'],
        ].map(([label, value, hint], index) => (
          <div key={label} className={cn('px-5 py-4', index % 2 === 1 && 'border-l border-border', index > 1 && 'border-t border-border md:border-t-0', index === 2 && 'md:border-l')}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={cn('mt-1 text-2xl font-semibold tracking-tight', label === 'Building now' && stats.building > 0 && 'spectrum-text')}>{value}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
          </div>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input type="text" placeholder="Search by application, branch, commit or author…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} aria-label="Search deployments" className="control-input pl-9" />
        </div>
        <label className="sr-only" htmlFor="deployment-project">Application</label>
        <select id="deployment-project" value={projectFilter} onChange={event => setProjectFilter(event.target.value)} className="control-input w-auto min-w-[180px]">
          <option value="all">All applications</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <div className="flex h-9 items-center rounded-md border border-border p-0.5" role="group" aria-label="Status">
          {statusFilters.map(filter => (
            <button key={filter.value} type="button" onClick={() => setStatusFilter(filter.value)} aria-pressed={statusFilter === filter.value}
              className={cn('h-full rounded-[5px] px-3 text-[13px] transition-colors', statusFilter === filter.value ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {loading ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3, 4].map(i => <div key={i} className="h-[68px] animate-pulse bg-white/[0.01]" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border"><Rocket className="h-5 w-5 text-muted-foreground" /></span>
            <p className="text-sm font-medium">{deployments.length ? 'No deployments match these filters' : 'No deployments yet'}</p>
            <p className="mt-1 text-sm text-muted-foreground">{deployments.length ? 'Try a different search or status.' : 'Deploy an application to see its pipeline here.'}</p>
            {!deployments.length && <Button asChild size="sm" className="mt-5"><Link href="/projects">Go to projects</Link></Button>}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map(deployment => <DeploymentRow key={deployment.id} deployment={deployment} now={now} />)}
          </div>
        )}
      </div>
    </AppShell>
  )
}
