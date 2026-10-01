import Link from 'next/link'
import type { ReactNode } from 'react'
import { GitBranch, GitCommitHorizontal, ShieldCheck, ShieldAlert } from 'lucide-react'
import { deploymentDuration, formatSeconds, relativeTime, stagesFromPhase } from '@/lib/deployment-stages'
import { PipelineMini } from './pipeline'
import { StatusLabel, type DeployStatus } from './status'

export interface DeploymentSummary {
  id: string
  project_id: string
  project_name?: string
  status: DeployStatus
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
  trigger?: string | null
  phase?: string | null
  security_status?: string | null
  is_active?: boolean
  user_name?: string | null
  log?: string | null
}

const triggerLabel = (trigger?: string | null) => !trigger ? 'Manual'
  : trigger === 'webhook' || trigger === 'github' ? 'Git push'
  : trigger.charAt(0).toUpperCase() + trigger.slice(1)

export function DeploymentRow({ deployment, now, showProject = true, compact = false, actions }: {
  deployment: DeploymentSummary
  now: number
  showProject?: boolean
  /** Two-line layout for narrow columns. */
  compact?: boolean
  actions?: ReactNode
}) {
  const live = deployment.status === 'running' || deployment.status === 'queued'
  const duration = deploymentDuration(deployment.started_at, deployment.finished_at, now)
  const stages = live ? stagesFromPhase(deployment.status, deployment.phase, deployment.log) : null
  const activeStage = stages?.find(stage => stage.state === 'active')
  if (compact) return (
    <div className="relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-white/[0.025]">
      <Link href={`/deployments/${deployment.id}`} className="absolute inset-0 z-0 focus-visible:outline-offset-[-2px]" aria-label={`Open deployment ${deployment.id.slice(0, 8)}${deployment.project_name ? ` of ${deployment.project_name}` : ''}`} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <StatusLabel status={deployment.status} label={activeStage && deployment.status === 'running' ? activeStage.label : undefined} className="shrink-0" />
          {showProject && deployment.project_name && <span className="truncate text-[13px] text-muted-foreground">· {deployment.project_name}</span>}
          {deployment.is_active && <span className="shrink-0 rounded-full border border-white/15 bg-white/[0.06] px-1.5 py-px text-[10px] font-medium">Current</span>}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-3 pl-[18px] text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1"><GitBranch className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{deployment.branch || '—'}</span></span>
          <span className="flex shrink-0 items-center gap-1 font-mono"><GitCommitHorizontal className="h-3.5 w-3.5" />{deployment.commit_sha?.slice(0, 7) || 'pending'}</span>
        </div>
        {stages && <PipelineMini stages={stages} className="mt-2 max-w-[220px] pl-[18px]" />}
      </div>
      <div className="shrink-0 text-right text-xs text-muted-foreground">
        <p>{live ? formatSeconds(duration) : relativeTime(deployment.started_at, now)}</p>
        <p className="mt-0.5">{live ? 'elapsed' : formatSeconds(duration)}</p>
      </div>
    </div>
  )
  return (
    <div className="group relative grid gap-x-6 gap-y-3 px-4 py-3.5 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(0,2fr)_minmax(130px,auto)] md:items-center">
      <Link href={`/deployments/${deployment.id}`} className="absolute inset-0 z-0 focus-visible:outline-offset-[-2px]" aria-label={`Open deployment ${deployment.id.slice(0, 8)}${deployment.project_name ? ` of ${deployment.project_name}` : ''}`} />

      <div className="min-w-0">
        <p className="truncate font-mono text-[13px] font-medium text-foreground">{deployment.id.slice(0, 8)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{triggerLabel(deployment.trigger)}</span>
          {deployment.is_active && <span className="rounded-full border border-white/15 bg-white/[0.06] px-1.5 py-px text-[10px] font-medium text-foreground">Current</span>}
        </div>
      </div>

      <div className="min-w-0">
        <StatusLabel status={deployment.status} label={activeStage && deployment.status === 'running' ? activeStage.label : undefined} />
        {stages ? (
          <PipelineMini stages={stages} className="mt-2 max-w-[160px]" />
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{formatSeconds(duration)}{deployment.finished_at ? ` · ${relativeTime(deployment.finished_at, now)}` : ''}</p>
        )}
      </div>

      <div className="min-w-0">
        {showProject && deployment.project_name && <p className="truncate text-[13px] font-medium">{deployment.project_name}</p>}
        <div className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${showProject ? 'mt-1' : ''}`}>
          <span className="flex min-w-0 items-center gap-1"><GitBranch className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{deployment.branch || '—'}</span></span>
          <span className="flex items-center gap-1 font-mono"><GitCommitHorizontal className="h-3.5 w-3.5" />{deployment.commit_sha?.slice(0, 7) || 'pending'}</span>
          {deployment.security_status === 'passed' && <span className="flex items-center gap-1 text-status-ready/90" title="Security gate passed"><ShieldCheck className="h-3.5 w-3.5" />Audited</span>}
          {deployment.security_status === 'failed' && <span className="flex items-center gap-1 text-status-failed" title="Security gate blocked this release"><ShieldAlert className="h-3.5 w-3.5" />Blocked</span>}
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-3 md:justify-end">
        <div className="min-w-0 text-xs text-muted-foreground md:text-right">
          <p className="truncate">{live ? formatSeconds(duration) + ' elapsed' : relativeTime(deployment.started_at, now)}</p>
          {deployment.user_name && <p className="mt-0.5 truncate">by {deployment.user_name}</p>}
        </div>
        {actions && <div className="relative z-10 flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </div>
  )
}
