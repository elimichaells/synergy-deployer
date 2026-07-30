'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode } from 'react'
import {
  LayoutDashboard,
  Boxes,
  Server,
  Rocket,
  Database,
  Settings,
  ChevronRight,
  LogOut,
  User
} from 'lucide-react'

const navItems = [
  { href: '/', label: 'Board', icon: LayoutDashboard },
  { href: '/sites', label: 'Sites', icon: Boxes },
  { href: '/services', label: 'Services', icon: Server },
  { href: '/deployments', label: 'Deployments', icon: Rocket },
  { href: '/database', label: 'Database', icon: Database },
  { href: '/settings', label: 'Settings', icon: Settings },
]


export function AppShell({
  children,
  title,
  subtitle,
  user,
  actions,
}: {
  children: ReactNode
  title: string
  subtitle?: string
  user?: { name?: string; role?: string }
  actions?: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      router.push('/login')
    }
  }

  return (
    <div className="min-h-screen text-foreground selection:bg-primary/20">
      <div className="flex h-screen">
        {/* Sidebar */}
        <aside className="glass-sidebar hidden w-72 flex-col md:flex">
          <div className="flex h-20 items-center px-8">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/25 to-primary/5 shadow-[0_0_20px_-4px_hsl(199_95%_55%/0.4)]">
                <Rocket className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Manager</p>
                <p className="text-sm font-semibold text-shine">NextOps Control</p>
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-4 py-4">
            {navItems.map((item) => {
              const active = isActive(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`group flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                    active
                      ? 'border border-primary/20 bg-primary/10 text-primary shadow-[inset_0_1px_0_hsl(199_95%_75%/0.1),0_0_20px_-8px_hsl(199_95%_55%/0.5)]'
                      : 'border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <item.icon className={`h-4 w-4 transition-transform group-hover:scale-110 ${active ? 'text-primary' : ''}`} />
                    {item.label}
                  </div>
                  <ChevronRight className={`h-3 w-3 transition-all ${active ? 'opacity-60' : 'opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0'}`} />
                </Link>
              )
            })}
          </nav>

          <div className="mt-auto p-4">
            <div className="glass-panel p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-gradient-to-br from-white/10 to-transparent">
                  <User className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="truncate text-xs font-semibold text-foreground">{user?.name || 'Signed in'}</p>
                  <p className="text-[10px] capitalize text-muted-foreground">{user?.role || 'operator'}</p>
                </div>
                <button
                  onClick={() => void handleLogout()}
                  title="Sign out"
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-red-400"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="glass-header sticky top-0 z-10">
            <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-8">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-shine">{title}</h1>
                {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
              </div>
              <div className="flex items-center gap-4">{actions}</div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="fade-in-up mx-auto max-w-7xl p-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
