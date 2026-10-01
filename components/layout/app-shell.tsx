'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronLeft, LogOut, Plus, Search } from 'lucide-react'
import { SynergyMark } from '@/components/synergy/brand'
import { CommandMenu } from '@/components/synergy/command-menu'
import { navItems } from '@/components/synergy/nav'

function initials(name?: string) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}

export function AppShell({ children, title, subtitle, user, actions, back, headerExtra }: {
  children: ReactNode
  title: string
  subtitle?: ReactNode
  user?: { name?: string; role?: string }
  actions?: ReactNode
  /** Small back link above the title, e.g. { href: '/deployments', label: 'Deployments' }. */
  back?: { href: string; label: string }
  /** Rendered under the title row inside the page header band. */
  headerExtra?: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [commandOpen, setCommandOpen] = useState(false)
  const [host, setHost] = useState('')
  const [sessionUser, setSessionUser] = useState<{ name?: string; role?: string; email?: string } | null>(null)
  const account = user?.name ? user : sessionUser

  useEffect(() => { setHost(window.location.hostname) }, [])

  // Pages that do not load the session themselves still get a populated account menu.
  useEffect(() => {
    if (user?.name) return
    let cancelled = false
    void fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(data => { if (!cancelled && data?.user) setSessionUser(data.user) }).catch(() => {})
    return () => { cancelled = true }
  }, [user?.name])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isActive = (href: string) => href === '/'
    ? pathname === '/'
    : pathname === href || pathname.startsWith(`${href}/`)

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      router.push('/login')
    }
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="spectrum-line" aria-hidden="true" />
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-2 px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md py-1 pr-1" aria-label="Synergy home">
            <SynergyMark className="h-6 w-6 text-foreground" />
            <span className="hidden text-[15px] font-semibold tracking-[-0.02em] sm:inline">Synergy</span>
          </Link>
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-white/15" aria-hidden="true"><path d="M16.88 3.549L7.12 20.451" stroke="currentColor" strokeWidth="1.5" /></svg>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-ready" title="Manager reachable" />
            <span className="truncate font-medium">{host || 'host'}</span>
            <span className="hidden rounded-full border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-muted-foreground md:inline">Single host</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setCommandOpen(true)} className="flex h-8 items-center gap-2 rounded-md border border-border bg-white/[0.02] px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground sm:w-56" aria-label="Open command menu">
              <Search className="h-3.5 w-3.5" />
              <span className="hidden flex-1 text-left sm:inline">Search…</span>
              <span className="kbd hidden sm:inline-flex">Ctrl K</span>
            </button>
            <Link href="/sites/new" className="hidden h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 md:flex">
              <Plus className="h-3.5 w-3.5" /> New
            </Link>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label="Account menu" className="flex h-8 w-8 items-center justify-center rounded-full p-[1.5px] spectrum-bar">
                  <span className="flex h-full w-full items-center justify-center rounded-full bg-background text-[11px] font-semibold">{initials(account?.name)}</span>
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={8} className="z-50 w-60 rounded-lg border border-white/10 bg-popover p-1 shadow-2xl shadow-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
                  <div className="px-3 py-2.5">
                    <p className="truncate text-sm font-medium">{account?.name || 'Signed in'}</p>
                    <p className="truncate text-xs capitalize text-muted-foreground">{account?.role || 'Account'}</p>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item asChild><Link href="/settings" className="flex cursor-pointer items-center rounded-md px-3 py-2 text-sm text-muted-foreground outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground">Settings</Link></DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => setCommandOpen(true)} className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm text-muted-foreground outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground">Command menu <span className="kbd">Ctrl K</span></DropdownMenu.Item>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item onSelect={() => void handleLogout()} className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm text-muted-foreground outline-none data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300">Sign out <LogOut className="h-3.5 w-3.5" /></DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>

        <nav className="mx-auto max-w-[1240px] px-2 sm:px-4" aria-label="Primary navigation">
          <div className="scrollbar-none flex overflow-x-auto">
            {navItems.map(item => {
              const active = isActive(item.href)
              return (
                <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                  className={`group relative shrink-0 px-1 pb-2.5 pt-1 text-[13px] transition-colors ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <span className="block rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">{item.label}</span>
                  {active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-foreground" aria-hidden="true" />}
                </Link>
              )
            })}
          </div>
        </nav>
      </header>

      <section className="relative overflow-hidden border-b border-border">
        <div className="syn-canvas pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto flex max-w-[1240px] flex-wrap items-end gap-x-6 gap-y-4 px-4 py-7 sm:px-6 sm:py-9">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            {back && <Link href={back.href} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"><ChevronLeft className="h-3.5 w-3.5" />{back.label}</Link>}
            <h1 className="truncate text-[26px] font-semibold leading-tight tracking-[-0.03em] sm:text-[32px]">{title}</h1>
            {subtitle && <div className="mt-1.5 truncate text-sm text-muted-foreground">{subtitle}</div>}
          </div>
          {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
          {headerExtra && <div className="w-full">{headerExtra}</div>}
        </div>
      </section>

      <main className="min-w-0">
        <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">{children}</div>
      </main>

      <footer className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 px-4 pb-8 pt-2 text-xs text-muted-foreground sm:px-6">
        <span className="flex items-center gap-2"><SynergyMark className="h-4 w-4" /> Synergy Deploy</span>
        <span className="hidden sm:inline">Zero-downtime releases with verified health checks</span>
      </footer>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  )
}
