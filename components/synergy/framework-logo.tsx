export type FrameworkType = 'next' | 'angular' | 'go' | 'laravel' | 'node' | string

export function FrameworkLogo({ type, className = 'h-6 w-6' }: { type?: FrameworkType | null; className?: string }) {
  if (type === 'angular') return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><path fill="#dd0031" d="M16 2 29 6.7 27 23.8 16 30 5 23.8 3 6.7Z" /><path fill="#fff" d="m16 6-7.2 16h3.6l1.45-3.6h4.3L19.6 22h3.6Zm0 5.1 1.15 4.2h-2.3Z" /></svg>
  if (type === 'next') return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><circle cx="16" cy="16" r="14" fill="#fff" /><path fill="#050505" d="M10 9h3.2l8.7 13.5V9H25v14.5h-3.2L13.1 10v13.5H10Z" /></svg>
  if (type === 'node') return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><path fill="#5fa04e" d="m16 2.5 12 6.8v13.4l-12 6.8-12-6.8V9.3Z" /><text x="16" y="19" textAnchor="middle" fill="white" fontSize="9" fontWeight="700">JS</text></svg>
  if (type === 'laravel') return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="6" fill="#ff2d20" /><path d="M10 8v12.5L16.5 24l6-3.5V14l-6 3.4-3-1.7V8Z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" /></svg>
  if (type === 'go') return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><rect x="2" y="7" width="28" height="18" rx="9" fill="#00add8" /><text x="16" y="20" textAnchor="middle" fill="white" fontSize="10" fontWeight="800" fontStyle="italic">GO</text></svg>
  return <svg viewBox="0 0 32 32" className={className} aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="7" fill="#262626" /><path d="M11 12l-3 4 3 4M21 12l3 4-3 4M17.5 10l-3 12" fill="none" stroke="#d4d4d4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** Framework logo seated in the bordered square used across Synergy lists. */
export function FrameworkAvatar({ type, size = 'md' }: { type?: FrameworkType | null; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-12 w-12' : size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'
  const logo = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
  return (
    <span className={`flex ${box} shrink-0 items-center justify-center rounded-full border border-border bg-black`}>
      <FrameworkLogo type={type} className={logo} />
    </span>
  )
}
