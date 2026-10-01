'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Globe2, Plus, RefreshCw, Rocket, Workflow } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { DeploymentRow, type DeploymentSummary } from '@/components/synergy/deployment-row'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { PipelineMini } from '@/components/synergy/pipeline'
import { StatusDot, statusMeta } from '@/components/synergy/status'
import { deploymentDuration, formatSeconds, relativeTime, stagesFromPhase } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface Project {
  id: string
  name: string
  is_active: boolean
  project_type: string
  environment: 'production' | 'staging'
  url: string | null
  port: number | null
  setup_required?: boolean
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

const DAY = 86_400_000

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setError(null)
    try {
      const [projectsRes, deploymentsRes, meRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/deployments?limit=100', { cache: 'no-store' }),
        silent ? Promise.resolve(null) : fetch('/api/auth/me'),
      ])

      if (!projectsRes.ok) throw new Error('Failed to load projects')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')

      setProjects(await projectsRes.json())
      setDeployments(await deploymentsRes.json())
      if (meRes?.ok) setUser((await meRes.json()).user)
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => { if (!document.hidden) void refresh(true) }, 8_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(poll); window.clearInterval(clock) }
  }, [refresh])

  const active = useMemo(() => deployments.filter(d => d.status === 'running' || d.status === 'queued'), [deployments])
  const latestByProject = useMemo(() => {
    const map = new Map<string, DeploymentSummary>()
    for (const deployment of deployments) if (!map.has(deployment.project_id)) map.set(deployment.project_id, deployment)
    return map
  }, [deployments])

  const stats = useMemo(() => {
    const week = deployments.filter(d => d.started_at && now - Date.parse(d.started_at) < 7 * DAY)
    const finished = week.filter(d => d.status === 'success' || d.status === 'failed')
    const ok = finished.filter(d => d.status === 'success')
    return {
      online: projects.filter(p => p.is_active).length,
      today: deployments.filter(d => d.started_at && now - Date.parse(d.started_at) < DAY).length,
      week: week.length,
      successRate: finished.length ? Math.round((ok.length / finished.length) * 100) : null,
      failing: [...latestByProject.values()].filter(d => d.status === 'failed').length,
    }
  }, [deployments, projects, latestByProject, now])

  const lastRelease = deployments.find(d => d.status === 'success')
  const greeting = new Date(now).getHours() < 12 ? 'Good morning' : new Date(now).getHours() < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <AppShell
      title={user?.name ? `${greeting}, ${user.name.split(' ')[0]}` : 'Overview'}
      subtitle="Everything shipping on this host, in one place."
      user={{ name: user?.name, role: user?.role }}
      actions={<>
        <Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</Button>
        <Button asChild size="sm"><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      {/* Pipeline pulse */}
      <section className="mb-6 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className={cn('h-2 w-2 rounded-full', active.length ? 'spectrum-flow' : 'bg-status-ready')} />
            <h2 className="text-sm font-semibold">{active.length ? `${active.length} pipeline${active.length > 1 ? 's' : ''} in flight` : 'All pipelines idle'}</h2>
          </div>
          <span className="text-xs text-muted-foreground">{lastRelease ? `Last release ${relativeTime(lastRelease.finished_at, now)} · ${lastRelease.project_name}` : 'No releases yet'}</span>
        </div>
        {active.length === 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-4">
            {[
              ['Applications', String(projects.length), `${stats.online} online`],
              ['Deploys today', String(stats.today), `${stats.week} this week`],
              ['Success rate', stats.successRate === null ? '—' : `${stats.successRate}%`, 'last 7 days'],
              ['Needs attention', String(stats.failing), stats.failing ? 'latest release failed' : 'everything healthy'],
            ].map(([label, value, hint], index) => (
              <div key={label} className={cn('px-5 py-4', index % 2 === 1 && 'border-l border-border', index > 1 && 'border-t border-border md:border-t-0', index === 2 && 'md:border-l')}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className={cn('mt-1 text-2xl font-semibold tracking-tight', label === 'Needs attention' && stats.failing > 0 && 'text-status-failed')}>{loading ? '–' : value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {active.map(deployment => {
              const stages = stagesFromPhase(deployment.status, deployment.phase, deployment.log)
              const current = stages.find(stage => stage.state === 'active')
              return (
                <Link key={deployment.id} href={`/deployments/${deployment.id}`} className="grid gap-3 px-5 py-4 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{deployment.project_name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{deployment.branch || '—'}{deployment.commit_sha ? ` · ${deployment.commit_sha.slice(0, 7)}` : ''}</p>
                  </div>
                  <div>
                    <PipelineMini stages={stages} />
                    <p className="mt-1.5 text-xs"><span className="spectrum-text font-medium">{deployment.status === 'queued' ? 'Queued' : current ? current.label : 'Building'}</span><span className="text-muted-foreground"> · {formatSeconds(deploymentDuration(deployment.started_at, null, now))}</span></p>
                  </div>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">Watch<ArrowRight className="h-3.5 w-3.5" /></span>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent deployments</h2>
            <Link href="/deployments" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">View all<ArrowRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {loading ? (
              <div className="divide-y divide-border">{[0, 1, 2, 3].map(i => <div key={i} className="h-[68px] animate-pulse" />)}</div>
            ) : deployments.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <Rocket className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">No deployments yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Releases appear here with their full pipeline.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {deployments.slice(0, 8).map(deployment => <DeploymentRow key={deployment.id} deployment={deployment} now={now} compact />)}
              </div>
            )}
          </div>
        </section>

        <aside className="min-w-0 space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Applications</h2>
              <Link href="/projects" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">All projects<ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {loading ? <div className="h-48 animate-pulse" /> : projects.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">No applications yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {projects.slice(0, 7).map(project => {
                    const latest = latestByProject.get(project.id)
                    return (
                      <Link key={project.id} href={`/sites/${project.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.025]">
                        <FrameworkAvatar type={project.project_type} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{project.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{project.url?.replace(/^https?:\/\//, '') || (project.port ? `localhost:${project.port}` : project.environment)}</p>
                        </div>
                        {project.setup_required ? <span className="text-[11px] text-amber-200">Setup</span> : latest ? (
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><StatusDot status={latest.status} className="scale-75" />{statusMeta[latest.status].label}</span>
                        ) : <span className="text-[11px] text-muted-foreground">Not deployed</span>}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold">Shortcuts</h2>
            <div className="grid gap-2">
              {[
                { href: '/sites/new', icon: Plus, title: 'Import a repository', hint: 'Build, verify and serve a new app' },
                { href: '/domains', icon: Globe2, title: 'Connect a domain', hint: 'Cloudflare DNS and automatic TLS' },
                { href: '/automation', icon: Workflow, title: 'Schedule a job', hint: 'Cron jobs and background workers' },
              ].map(item => (
                <Link key={item.href} href={item.href} className="syn-tile flex items-center gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-black"><item.icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{item.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </AppShell>
  )
}
