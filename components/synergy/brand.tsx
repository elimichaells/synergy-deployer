import { useId } from 'react'

/** Two releases converging: the lens where the rings overlap is the live release. */
export function SynergyMark({ className = 'h-6 w-6' }: { className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`syn-${id}`} x1="3" y1="4" x2="21" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="hsl(258 90% 68%)" />
          <stop offset="0.55" stopColor="hsl(189 94% 56%)" />
          <stop offset="1" stopColor="hsl(158 72% 56%)" />
        </linearGradient>
      </defs>
      <circle cx="9" cy="12" r="6" fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.6" />
      <circle cx="15" cy="12" r="6" fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.6" />
      <path d="M12 6.8A6 6 0 0 1 12 17.2A6 6 0 0 1 12 6.8Z" fill={`url(#syn-${id})`} />
    </svg>
  )
}

export function SynergyWordmark({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <SynergyMark className="h-6 w-6 shrink-0 text-foreground" />
      <span className="truncate text-[15px] font-semibold tracking-[-0.02em]">Synergy</span>
      {subtitle && <span className="hidden rounded-full border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">Deploy</span>}
    </span>
  )
}
