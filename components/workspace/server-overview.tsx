'use client'

import { DeploymentRow, type DeploymentSummary } from '@/components/synergy/deployment-row'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { PipelineMini } from '@/components/synergy/pipeline'
import { deploymentDuration, formatSeconds, relativeTime, stagesFromPhase } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'
import { ArrowRight, Rocket } from 'lucide-react'
import Link from 'next/link'

export interface OverviewApp {
  id: string; name: string; project_type: string; environment: string; url: string | null; port: number | null
  href: string; readiness: string; statusLabel: string; setup_required?: boolean
}
export function ServerOverviewContent({ projects, deployments, now, loading = false, healthHint, projectsHref, deploymentsHref, shortcuts, historyNote }: {
  projects: OverviewApp[]; deployments: DeploymentSummary[]; now: number; loading?: boolean; healthHint: string
  projectsHref: string; deploymentsHref: string; shortcuts: { href: string; icon: LucideIcon; title: string; hint: string }[]; historyNote?: string
}) {
  const active = deployments.filter(d => d.status === 'running' || d.status === 'queued')
  const latest = new Map<string, DeploymentSummary>()
  for (const d of deployments) if (!latest.has(d.project_id)) latest.set(d.project_id, d)
  const week = deployments.filter(d => d.started_at && now - Date.parse(d.started_at) < 7 * 86400000)
  const finished = week.filter(d => d.status === 'success' || d.status === 'failed')
  const stats = {
    today: deployments.filter(d => d.started_at && now - Date.parse(d.started_at) < 86400000).length,
    week: week.length,
    successRate: finished.length ? Math.round(finished.filter(d => d.status === 'success').length / finished.length * 100) : null,
    failing: [...latest.values()].filter(d => d.status === 'failed').length,
  }
  const lastRelease = deployments.find(d => d.status === 'success')
  return <>
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
              ['Applications', String(projects.length), healthHint],
              ['Deploys today', String(stats.today), `${stats.week} this week`],
              ['Success rate', stats.successRate === null ? '—' : `${stats.successRate}%`, 'last 7 days'],
              ['Needs attention', String(stats.failing), stats.failing ? 'latest release failed' : 'no recent release failures'],
            ].map(([label, value, hint], index) => (
              <div key={label} className={cn('metric-tile px-5 py-4', index % 2 === 1 && 'border-l border-border', index > 1 && 'border-t border-border md:border-t-0', index === 2 && 'md:border-l')} data-tone={index % 3}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className={cn('mt-1 text-2xl font-semibold tracking-tight', label === 'Needs attention' && stats.failing > 0 && 'text-status-failed')}>{loading ? '–' : value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {active.map(deployment => {
              const stages = deployment.stages || stagesFromPhase(deployment.status, deployment.phase, deployment.log)
              const current = stages.find(stage => stage.state === 'active')
              return (
                <Link key={deployment.id} href={deployment.href || `/deployments/${deployment.id}`} className="grid gap-3 px-5 py-4 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-center">
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
            <Link href={deploymentsHref} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">View all<ArrowRight className="h-3.5 w-3.5" /></Link>
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
              <Link href={projectsHref} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">All projects<ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {loading ? <div className="h-48 animate-pulse" /> : projects.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">No applications yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {projects.slice(0, 7).map(project => {
                    const readiness = project.readiness
                    return (
                      <Link key={project.id} href={project.href} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.025]">
                        <FrameworkAvatar type={project.project_type} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{project.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{project.url?.replace(/^https?:\/\//, '') || (project.port ? `localhost:${project.port}` : project.environment)}</p>
                        </div>
                        <span className={cn('text-[11px]', readiness === 'ready' ? 'text-status-ready' : readiness === 'degraded' || readiness === 'offline' ? 'text-status-building' : 'text-muted-foreground')}>{project.setup_required ? 'Setup' : project.statusLabel}</span>
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
              {shortcuts.map(item => (
                <Link key={item.href} href={item.href} className="syn-tile flex items-center gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-well"><item.icon className="h-4 w-4" /></span>
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
      {historyNote && <p className="mt-3 text-[11px] text-muted-foreground">{historyNote}</p>}
    </>
}
