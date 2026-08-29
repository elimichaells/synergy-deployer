'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useState } from 'react'
import { Boxes, Database, Gauge, LogOut, Menu, Rocket, Server, Settings, User, Workflow, X } from 'lucide-react'

const navGroups = [
  { label: 'Operate', items: [
    { href: '/', label: 'Overview', icon: Gauge },
    { href: '/sites', label: 'Applications', icon: Boxes },
    { href: '/deployments', label: 'Deployments', icon: Rocket },
    { href: '/automation', label: 'Automation', icon: Workflow },
  ] },
  { label: 'Infrastructure', items: [
    { href: '/services', label: 'Runtime & proxy', icon: Server },
    { href: '/database', label: 'Databases', icon: Database },
  ] },
  { label: 'Administration', items: [
    { href: '/settings', label: 'Settings', icon: Settings },
  ] },
]

function ProductMark() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-cyan-400/30 bg-cyan-400/10">
        <Rocket className="h-4 w-4 text-cyan-300" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">Manager</p>
        <p className="truncate text-[11px] text-muted-foreground">Deployment control plane</p>
      </div>
    </div>
  )
}

export function AppShell({ children, title, subtitle, user, actions }: {
  children: ReactNode
  title: string
  subtitle?: string
  user?: { name?: string; role?: string }
  actions?: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)

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

  const navigation = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5" aria-label="Primary navigation">
      {navGroups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 px-3 text-[10px] font-semibold uppercase text-muted-foreground/70">{group.label}</p>
          <div className="space-y-1">
            {group.items.map((item) => {
              const active = isActive(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-10 items-center gap-3 rounded-md border-l-2 px-3 text-sm transition-colors ${active
                    ? 'border-cyan-400 bg-cyan-400/10 text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
                  }`}
                >
                  <item.icon className={`h-4 w-4 ${active ? 'text-cyan-300' : ''}`} />
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )

  const account = (
    <div className="border-t border-border/70 p-3">
      <div className="flex items-center gap-3 rounded-md px-3 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
          <User className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{user?.name || 'Signed in'}</p>
          <p className="text-[10px] capitalize text-muted-foreground">{user?.role || 'operator'}</p>
        </div>
        <button onClick={() => void handleLogout()} title="Sign out" aria-label="Sign out" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-300">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-[hsl(var(--sidebar))] md:flex">
          <div className="flex h-16 items-center border-b border-border px-5"><ProductMark /></div>
          {navigation}
          {account}
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <button className="absolute inset-0 bg-black/70" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />
            <aside className="relative flex h-full w-[min(19rem,85vw)] flex-col border-r border-border bg-[hsl(var(--sidebar))] shadow-2xl">
              <div className="flex h-16 items-center justify-between border-b border-border px-5">
                <ProductMark />
                <button onClick={() => setMobileOpen(false)} aria-label="Close navigation" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              {navigation}
              {account}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-border bg-background/95 backdrop-blur">
            <div className="mx-auto flex min-h-16 max-w-[1440px] flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:px-6 lg:px-8">
              <button onClick={() => setMobileOpen(true)} aria-label="Open navigation" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground md:hidden">
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold leading-6 sm:text-xl">{title}</h1>
                {subtitle && <p className="truncate text-xs text-muted-foreground sm:text-sm">{subtitle}</p>}
              </div>
              {actions && <div className="flex w-full shrink-0 items-center gap-2 overflow-x-auto pb-1 sm:w-auto sm:pb-0">{actions}</div>}
            </div>
          </header>

          <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto max-w-[1440px] p-4 sm:p-6 lg:p-8">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
