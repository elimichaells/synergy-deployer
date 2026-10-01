'use client'

import { Check } from 'lucide-react'
import { SETUP_STEPS, type SetupStep } from '@/lib/project-setup-policy'
import { cn } from '@/lib/utils'

export const SETUP_LABELS: Record<SetupStep, { title: string; hint: string }> = {
  repository: { title: 'Source', hint: 'Clone and inspect' },
  runtime: { title: 'Build', hint: 'Framework and commands' },
  database: { title: 'Database', hint: 'Storage for your data' },
  environment: { title: 'Environment', hint: 'Secrets and settings' },
  domain: { title: 'Domain', hint: 'Public address' },
  review: { title: 'Deploy', hint: 'Check and go live' },
}

/** Vertical progress rail: finished steps show a check, the current one is highlighted. */
export function SetupSteps({ step, onSelect, disabled = false, completed = [] }: { step: SetupStep; onSelect?: (step: SetupStep) => void; disabled?: boolean; completed?: SetupStep[] }) {
  const current = SETUP_STEPS.indexOf(step)
  return <>
    <div className="flex items-center gap-3 lg:hidden">
      <div className="flex flex-1 gap-1" aria-hidden="true">{SETUP_STEPS.map((value, index) => <span key={value} className={cn('h-1 flex-1 rounded-full', index < current || completed.includes(value) ? 'bg-foreground/70' : index === current ? 'spectrum-bar' : 'bg-white/10')} />)}</div>
      <label className="sr-only" htmlFor="setup-step-select">Setup step</label>
      <select id="setup-step-select" className="control-input h-8 w-auto text-xs" value={step} disabled={disabled || !onSelect} onChange={event => onSelect?.(event.target.value as SetupStep)}>
        {SETUP_STEPS.map((value, index) => <option key={value} value={value}>{index + 1}. {SETUP_LABELS[value].title}</option>)}
      </select>
    </div>
    <nav aria-label="Application setup" className="hidden lg:block">
      <ol className="relative">
        {SETUP_STEPS.map((value, index) => {
          const done = value !== step && (completed.includes(value) || index < current)
          const active = value === step
          return (
            <li key={value} className="relative pb-6 last:pb-0">
              {index < SETUP_STEPS.length - 1 && <span className={cn('absolute left-[13px] top-8 h-[calc(100%-28px)] w-px', done ? 'bg-foreground/40' : 'bg-white/10')} aria-hidden="true" />}
              <button type="button" aria-current={active ? 'step' : undefined} disabled={disabled || !onSelect} onClick={() => onSelect?.(value)}
                className="group flex w-full items-start gap-3 text-left disabled:cursor-default">
                <span className={cn('relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors',
                  active ? 'border-foreground bg-foreground text-background' : done ? 'border-foreground/50 bg-background text-foreground' : 'border-white/15 bg-background text-muted-foreground group-hover:border-white/30')}>
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : index + 1}
                </span>
                <span className="min-w-0 pt-0.5">
                  <span className={cn('block text-sm font-medium', active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')}>{SETUP_LABELS[value].title}</span>
                  <span className="block text-xs text-muted-foreground/80">{SETUP_LABELS[value].hint}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  </>
}
