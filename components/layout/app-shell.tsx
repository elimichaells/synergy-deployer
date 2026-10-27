'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, Suspense, useCallback, useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronLeft, LogOut, Plus, Search, Server } from 'lucide-react'
import { SynergyMark } from '@/components/synergy/brand'
import { CommandMenu } from '@/components/synergy/command-menu'
import { infrastructureItems, isNavActive, workspaceNavItems } from '@/components/synergy/nav'
import { ServerHealthBanner } from '@/components/server-health'
import { ServerDirectoryProvider } from '@/components/infrastructure/server-directory'
import { ServerSwitcher } from '@/components/infrastructure/server-switcher'
import { serverScope } from '@/lib/server-navigation'
import { WorkspaceBar, type WorkspaceContextInfo } from './workspace-bar'
import { ThemeSwitcher } from './theme-switcher'
import { useWorkspace } from './workspace-provider'

function initials(name?: string) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}

type AppShellProps = {
  children: ReactNode
  title: string
  subtitle?: ReactNode
  user?: { name?: string; role?: string }
  actions?: ReactNode
  /** Small back link above the title, e.g. { href: '/deployments', label: 'Deployments' }. */
  back?: { href: string; label: string }
  /** Rendered under the title row inside the page header band. */
  headerExtra?: ReactNode
  /** Section tabs rendered flush with the bottom edge of the page header. */
  tabs?: ReactNode
  /** Adds the side menu for a multi-page area. */
  area?: 'infrastructure'
  workspace?: WorkspaceContextInfo
  unsavedChanges?: boolean
  onWorkspaceHashChange?: (hash: string) => void
}

export function AppShell(props: AppShellProps) {
  return <ServerDirectoryProvider><WorkspaceShell {...props} /></ServerDirectoryProvider>
}

function WorkspaceShell({ children, title, subtitle, user, actions, back, headerExtra, tabs, area, workspace, unsavedChanges = false, onWorkspaceHashChange }: AppShellProps) {
  const pathname = usePathname()
  const scope = serverScope(pathname)
  const router = useRouter()
  const { clear, setUnsaved } = useWorkspace()
  useEffect(() => { setUnsaved(unsavedChanges); return () => setUnsaved(false) }, [unsavedChanges, setUnsaved])
  const [commandOpen, setCommandOpen] = useState(false)
  const [hash, setHash] = useState('')
  const changeHash = useCallback((value: string) => { setHash(value); onWorkspaceHashChange?.(value) }, [onWorkspaceHashChange])
  const [sessionUser, setSessionUser] = useState<{ name?: string; role?: string; email?: string } | null>(null)
  const account = user?.name ? user : sessionUser

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


  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      clear()
      router.push('/login')
    }
  }

  return (
    <div className="manager-shell min-h-dvh bg-background text-foreground">
      <a href="#workspace-content" onClick={event => { event.preventDefault(); const content = document.getElementById('workspace-content'); content?.focus(); content?.scrollIntoView({ block: 'start' }) }} className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">Skip to content</a>
      <header className="manager-header sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-xl">
        <div className="spectrum-line" aria-hidden="true" />
        <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-1.5 px-3 sm:gap-2 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2 rounded-md py-1 pr-1" aria-label="Synergy home">
            <SynergyMark className="h-6 w-6 text-foreground" />
            <span className="hidden text-[15px] font-semibold tracking-[-0.02em] sm:inline">Synergy</span>
          </Link>
          <svg viewBox="0 0 24 24" className="hidden h-5 w-5 shrink-0 text-white/15 sm:block" aria-hidden="true"><path d="M16.88 3.549L7.12 20.451" stroke="currentColor" strokeWidth="1.5" /></svg>
          <ServerSwitcher scope={scope} />
          {process.env.NEXT_PUBLIC_WORKSPACE_PREVIEW === '1' && <span className="hidden rounded border border-amber-400/20 bg-amber-400/5 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 md:block">Preview</span>}

          <div className="ml-auto flex items-center gap-2">
            <ThemeSwitcher />
            <button type="button" onClick={() => setCommandOpen(true)} className="flex h-8 items-center gap-2 rounded-md border border-border bg-white/[0.02] px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground sm:w-56" aria-label="Open command menu">
              <Search className="h-3.5 w-3.5" />
              <span className="hidden flex-1 text-left sm:inline">Search…</span>
              <span className="kbd hidden sm:inline-flex">Ctrl K</span>
            </button>
            {scope.kind === 'local' && account?.role === 'admin' && <Link href="/sites/new" className="hidden h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background transition-opacity hover:opacity-90 md:flex">
              <Plus className="h-3.5 w-3.5" /> New
            </Link>}
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
            {workspaceNavItems(pathname).map(item => {
              const section = item.href.includes('#') ? '#' + item.href.split('#')[1] : ''
              const activeSection = hash.startsWith('#app-') ? '#applications' : hash
              const active = section ? activeSection === section : isNavActive(pathname, item.matches) && !(scope.kind === 'remote' && ['#applications', '#deployments', '#server-access'].includes(activeSection))
              return (
                <Link key={item.href} href={item.href} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) changeHash(section) }} aria-current={active ? 'page' : undefined}
                  className={`group relative shrink-0 px-1 pb-2.5 pt-1 text-[13px] transition-colors ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <span className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-accent ${active ? 'bg-primary/[0.07] text-primary' : ''}`}><item.icon className="hidden h-3.5 w-3.5 sm:block" />{item.label}</span>
                  {active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-primary" aria-hidden="true" />}
                </Link>
              )
            })}
          </div>
        </nav>
        <Suspense fallback={<div className="h-[70px] border-t border-border" />}><WorkspaceBar title={title} context={workspace} onNew={() => setCommandOpen(true)} onHashChange={changeHash} /></Suspense>
      </header>

      <section className="manager-page-header relative overflow-hidden border-b border-border">
        <div className="syn-canvas pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className={`relative mx-auto flex max-w-[1240px] flex-wrap items-end gap-x-6 gap-y-4 px-4 pt-7 sm:px-6 sm:pt-9 ${tabs ? 'pb-0' : 'pb-7 sm:pb-9'}`}>
          <div className="w-full min-w-0 sm:w-auto sm:min-w-[260px] sm:flex-1">
            {back && <Link href={back.href} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"><ChevronLeft className="h-3.5 w-3.5" />{back.label}</Link>}
            <h1 title={title} className="truncate text-[26px] font-semibold leading-tight tracking-[-0.03em] sm:text-[32px]">{title}</h1>
            {subtitle && <div className="mt-1.5 truncate text-sm text-muted-foreground">{subtitle}</div>}
          </div>
          {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
          {headerExtra && <div className="w-full">{headerExtra}</div>}
          {tabs && <div className="-mx-2 w-[calc(100%+16px)] pt-2 sm:-mx-3 sm:w-[calc(100%+24px)]">{tabs}</div>}
        </div>
      </section>

      <main id="workspace-content" tabIndex={-1} className="min-w-0 outline-none">
        <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
          {scope.kind === 'local' && <ServerHealthBanner />}
          {area === 'infrastructure' && scope.kind === 'local' ? (
            <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
              <aside className="min-w-0 lg:sticky lg:top-56 lg:max-h-[calc(100vh-15rem)] lg:self-start lg:overflow-y-auto">
                <nav aria-label="Infrastructure" className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
                  <Link href="/infrastructure" aria-current={pathname === '/infrastructure' ? 'page' : undefined}
                    className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${pathname === '/infrastructure' ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'}`}>
                    <Server className="h-4 w-4" />Overview
                  </Link>
                  {infrastructureItems.map(item => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                    return (
                      <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                        className={`flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${active ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'}`}>
                        <item.icon className="h-4 w-4" />{item.label}
                      </Link>
                    )
                  })}
                </nav>
                <p className="mt-6 hidden rounded-lg border border-border p-3 text-xs leading-5 text-muted-foreground lg:block">Server-wide settings for administrators. To give an app a database or a domain, open its <Link href="/projects" className="text-foreground underline-offset-4 hover:underline">project</Link>.</p>
              </aside>
              <div className="min-w-0">{children}</div>
            </div>
          ) : children}
        </div>
      </main>

      <footer className="mx-auto flex max-w-[1240px] items-center justify-between gap-4 px-4 pb-8 pt-2 text-xs text-muted-foreground sm:px-6">
        <span className="flex items-center gap-2"><SynergyMark className="h-4 w-4" /> Synergy Deploy</span>
        <span className="hidden sm:inline">Application deployments and server operations</span>
      </footer>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  )
}
