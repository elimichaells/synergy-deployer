import { cn } from '@/lib/utils'

export type DeployStatus = 'queued' | 'running' | 'success' | 'failed'

export const statusMeta: Record<DeployStatus, { label: string; dot: string; text: string }> = {
  success: { label: 'Ready', dot: 'bg-status-ready', text: 'text-status-ready' },
  running: { label: 'Building', dot: 'bg-status-building', text: 'text-status-building' },
  failed: { label: 'Error', dot: 'bg-status-failed', text: 'text-status-failed' },
  queued: { label: 'Queued', dot: 'bg-status-queued', text: 'text-muted-foreground' },
}

export function StatusDot({ status, className }: { status: DeployStatus; className?: string }) {
  const live = status === 'running' || status === 'queued'
  return (
    <span className={cn('relative inline-flex h-2.5 w-2.5 shrink-0', className)} aria-hidden="true">
      {live && <span className={cn('absolute inset-0 rounded-full heartbeat', statusMeta[status].dot)} />}
      <span className={cn('relative h-2.5 w-2.5 rounded-full', statusMeta[status].dot)} />
    </span>
  )
}

export function StatusLabel({ status, className, label }: { status: DeployStatus; className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-[13px] font-medium', className)}>
      <StatusDot status={status} />
      <span className="text-foreground">{label || statusMeta[status].label}</span>
    </span>
  )
}

export function EnvironmentBadge({ environment, current }: { environment?: string | null; current?: boolean }) {
  if (!environment && !current) return null
  return (
    <span className="inline-flex items-center gap-1">
      {environment && <span className={cn('rounded-full border px-2 py-px text-[11px] font-medium capitalize',
        environment === 'production' ? 'border-sky-400/25 bg-sky-400/[0.06] text-sky-300' : 'border-amber-300/25 bg-amber-300/[0.06] text-amber-200')}>{environment === 'production' ? 'Production' : 'Staging'}</span>}
      {current && <span className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-px text-[11px] font-medium text-foreground">Current</span>}
    </span>
  )
}
