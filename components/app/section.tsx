import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Vercel-style settings card: title and plain-language description, content, and an optional footer bar. */
export function Section({ title, description, action, footer, children, className, tone, id }: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
  tone?: 'danger'
  id?: string
}) {
  return (
    <section id={id} className={cn('overflow-hidden rounded-xl border bg-card', tone === 'danger' ? 'border-red-500/30' : 'border-border', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="min-w-0 max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {children && <div className="px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>}
      {footer && <div className={cn('flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-sm text-muted-foreground sm:px-6', tone === 'danger' ? 'border-red-500/30 bg-red-500/[0.04]' : 'border-border bg-white/[0.015]')}>{footer}</div>}
    </section>
  )
}

/** Choice card used for "pick one" decisions (database type, role, environments). */
export function ChoiceCard({ selected, disabled, onSelect, icon, title, description, badge }: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  badge?: ReactNode
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onSelect}
      className={cn('relative flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        selected ? 'border-foreground/70 bg-white/[0.05]' : 'border-border hover:border-white/25 hover:bg-white/[0.02]')}>
      {icon && <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-black">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{title}{badge}</span>
        {description && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>}
      </span>
      <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-foreground' : 'border-white/25')}>
        {selected && <span className="h-2 w-2 rounded-full bg-foreground" />}
      </span>
    </button>
  )
}

/** Plain-language status line: icon, sentence, optional action. */
export function StatusLine({ tone, icon, children, action }: { tone: 'ok' | 'warn' | 'off' | 'info'; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
        tone === 'ok' ? 'border-status-ready/30 bg-status-ready/10 text-status-ready'
          : tone === 'warn' ? 'border-status-building/30 bg-status-building/10 text-status-building'
          : tone === 'info' ? 'border-syn-cyan/30 bg-syn-cyan/10 text-syn-cyan'
          : 'border-border bg-white/[0.03] text-muted-foreground')}>{icon}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export const roleLabels: Record<string, string> = { application: 'Application', frontend: 'Frontend', backend: 'Backend API', service: 'Service' }
