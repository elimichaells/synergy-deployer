import type { DeploymentSummary } from '@/components/synergy/deployment-row'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { StatusLabel } from '@/components/synergy/status'
import { Button } from '@/components/ui/button'
import { deploymentDuration, formatSeconds, relativeTime } from '@/lib/deployment-stages'
import { PROJECT_TYPES as projectTypeDefaults, type ProjectType } from '@/lib/project-types'
import { cn } from '@/lib/utils'
import { ArrowUpRight, GitBranch, GitCommitHorizontal } from 'lucide-react'
import Link from 'next/link'
const commitUrl = (repo: string | null | undefined, sha: string | null) => {
  const match = repo && /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo)
  return match && sha ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null
}
export function ApplicationRelease({ project, live, primaryUrl, address, hasRunningDeploy, clock, statusLabel, statusHint, changeTab, runtimeLogs = true, releaseLabel = 'Live deployment', unlistedRelease }: {
  project: { project_type: ProjectType; default_branch: string; repo_url: string | null }; live: DeploymentSummary | null
  primaryUrl: string | null; address: string | null; hasRunningDeploy: boolean; clock: number
  statusLabel: string; statusHint: string; changeTab: (tab: 'logs' | 'deployments') => void; runtimeLogs?: boolean; releaseLabel?: string; unlistedRelease?: { commit: string; releasedAt: string | null }
}) {
  return (
            <section className="grid overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="relative flex min-h-[240px] flex-col justify-between overflow-hidden border-b border-border bg-well p-6 lg:border-b-0 lg:border-r">
                <div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
                {hasRunningDeploy && <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-syn-violet/20 blur-3xl" aria-hidden="true" />}
                <div className="relative flex items-center gap-3">
                  <FrameworkAvatar type={project.project_type} size="lg" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{projectTypeDefaults[project.project_type]?.label || project.project_type}</p>
                    {address ? (primaryUrl ? <a href={primaryUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-lg font-semibold tracking-tight hover:underline">{address}<ArrowUpRight className="h-4 w-4 shrink-0" /></a> : <p className="truncate font-mono text-lg font-semibold">{address}</p>) : <p className="text-lg font-semibold">No address yet</p>}
                  </div>
                </div>
                <div className="relative mt-8">
                  <p className={cn('text-3xl font-semibold tracking-[-0.03em]', hasRunningDeploy && 'spectrum-text')}>
                    {statusLabel}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {statusHint}
                  </p>
                </div>
              </div>
              <dl className="grid content-start gap-x-6 gap-y-5 p-6 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2"><dt className="eyebrow">{releaseLabel}</dt><dd>{live ? <Link href={live.href || `/deployments/${live.id}`} className="flex items-center gap-2 hover:underline"><StatusLabel status={live.status} /><span className="font-mono text-xs text-muted-foreground">{live.id.slice(0, 8)}</span></Link> : <span className="text-muted-foreground">{unlistedRelease ? `Active commit ${unlistedRelease.commit.slice(0,7)} · outside loaded history` : 'None yet'}</span>}</dd></div>
                <div><dt className="eyebrow">Released</dt><dd>{live ? <>{relativeTime(live.finished_at, clock)}{live.user_name && <span className="text-muted-foreground"> by {live.user_name}</span>}</> : unlistedRelease ? relativeTime(unlistedRelease.releasedAt, clock) : '—'}</dd></div>
                <div><dt className="eyebrow">Build time</dt><dd className="font-mono">{live ? formatSeconds(deploymentDuration(live.started_at, live.finished_at)) : '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="eyebrow">Source</dt><dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1.5"><GitBranch className="h-4 w-4 text-muted-foreground" />{live?.branch || project.default_branch}</span>
                  {live?.commit_sha && (commitUrl(project.repo_url, live.commit_sha)
                    ? <a href={commitUrl(project.repo_url, live.commit_sha)!} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono hover:underline"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{live.commit_sha.slice(0, 7)}</a>
                    : <span className="flex items-center gap-1.5 font-mono"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{live.commit_sha.slice(0, 7)}</span>)}
                </dd></div>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  {live && <Button asChild variant="outline" size="sm"><Link href={live.href || `/deployments/${live.id}`}>Build logs</Link></Button>}
                  {runtimeLogs && <Button variant="outline" size="sm" onClick={() => changeTab('logs')}>Runtime logs</Button>}
                  <Button variant="outline" size="sm" onClick={() => changeTab('deployments')}>All deployments</Button>
                </div>
              </dl>
            </section>
  )
}
