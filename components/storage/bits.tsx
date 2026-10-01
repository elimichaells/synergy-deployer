import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const serverRoleLabel: Record<string, { label: string; className: string }> = {
  system: { label: 'Synergy system server', className: 'border-amber-300/30 bg-amber-300/[0.06] text-amber-200' },
  apps: { label: 'Apps server', className: 'border-border text-muted-foreground' },
  external: { label: 'External', className: 'border-sky-400/25 text-sky-300' },
}

export function Flag({ tone, children }: { tone: 'warn' | 'danger' | 'info'; children: ReactNode }) {
  return <span className={cn('rounded-full border px-2 py-px text-[11px]', tone === 'danger' ? 'border-status-failed/40 bg-status-failed/[0.08] text-red-300' : tone === 'warn' ? 'border-status-building/40 bg-status-building/[0.06] text-amber-200' : 'border-sky-400/25 text-sky-300')}>{children}</span>
}
