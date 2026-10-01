import { Check, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatSeconds, type PipelineStage, type StageState } from '@/lib/deployment-stages'

const segmentTone: Record<StageState, string> = {
  done: 'bg-foreground/60',
  active: 'spectrum-flow',
  failed: 'bg-status-failed',
  pending: 'bg-white/[0.08]',
  skipped: 'bg-white/[0.04]',
}

/** Compact segmented bar for list rows. */
export function PipelineMini({ stages, className }: { stages: PipelineStage[]; className?: string }) {
  return (
    <div className={cn('flex h-1.5 w-full gap-[3px]', className)} role="img" aria-label={stages.map(stage => `${stage.label}: ${stage.state}`).join(', ')}>
      {stages.map(stage => <span key={stage.key} className={cn('h-full flex-1 rounded-full', segmentTone[stage.state])} />)}
    </div>
  )
}

function StageNode({ state }: { state: StageState }) {
  if (state === 'done') return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>
  if (state === 'failed') return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-status-failed text-white"><X className="h-3.5 w-3.5" strokeWidth={3} /></span>
  if (state === 'active') return (
    <span className="relative flex h-6 w-6 items-center justify-center">
      <span className="absolute inset-0 animate-spin rounded-full p-[2px] [background:conic-gradient(from_0deg,hsl(var(--syn-violet)),hsl(var(--syn-cyan)),hsl(var(--syn-mint)),transparent_75%)] [mask:radial-gradient(farthest-side,transparent_calc(100%-2px),#000_calc(100%-2px))]" style={{ animationDuration: '1.1s' }} />
      <span className="h-2 w-2 rounded-full bg-syn-cyan" />
    </span>
  )
  if (state === 'skipped') return <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-white/15 text-muted-foreground/50"><Minus className="h-3 w-3" /></span>
  return <span className="flex h-6 w-6 items-center justify-center rounded-full border border-white/15"><span className="h-1.5 w-1.5 rounded-full bg-white/20" /></span>
}

/** Full Synergy pipeline: every stage of a release, from checkout to health check. */
export function PipelineRail({ stages, className }: { stages: PipelineStage[]; className?: string }) {
  return (
    <ol className={cn('flex min-w-0 overflow-x-auto pb-1', className)}>
      {stages.map((stage, index) => {
        const next = stages[index + 1]
        const connector = !next ? null
          : next.state === 'active' ? 'spectrum-flow'
          : stage.state === 'done' && (next.state === 'done' || next.state === 'skipped' || next.state === 'failed') ? 'bg-foreground/50'
          : stage.state === 'skipped' && next.state !== 'pending' ? 'bg-foreground/25'
          : 'bg-white/[0.08]'
        return (
          <li key={stage.key} className="relative flex min-w-[72px] flex-1 flex-col items-center gap-2 text-center">
            {connector && <span className={cn('absolute left-[calc(50%+16px)] right-[calc(-50%+16px)] top-3 h-[2px] rounded-full', connector)} aria-hidden="true" />}
            <StageNode state={stage.state} />
            <span className={cn('text-xs font-medium', stage.state === 'pending' || stage.state === 'skipped' ? 'text-muted-foreground/70' : stage.state === 'failed' ? 'text-status-failed' : 'text-foreground')}>{stage.label}</span>
            <span className="-mt-1.5 font-mono text-[10px] text-muted-foreground">
              {stage.state === 'skipped' ? 'skipped' : stage.state === 'active' ? 'running' : stage.durationSec !== null ? formatSeconds(stage.durationSec) : stage.state === 'failed' ? 'failed' : '—'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
