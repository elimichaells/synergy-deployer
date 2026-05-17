import Link from 'next/link'
import { ReactNode } from 'react'
import {
  LayoutDashboard,
  Boxes,
  Server,
  Rocket,
  Settings,
  ChevronRight,
  User
} from 'lucide-react'

const navItems = [
  { href: '/', label: 'Board', icon: LayoutDashboard },
  { href: '/sites', label: 'Sites', icon: Boxes },
  { href: '/services', label: 'Services', icon: Server },
  { href: '/deployments', label: 'Deployments', icon: Rocket },
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
  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/20">
      <div className="flex h-screen">
        {/* Sidebar */}
        <aside className="hidden w-72 flex-col border-r border-border bg-card/30 md:flex">
          <div className="flex h-24 items-center px-8">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30">
                <Rocket className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Manager</p>
                <p className="text-sm font-semibold text-foreground">NextOps Control</p>
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-1.5 px-4 py-4">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group flex items-center justify-between rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-primary/10 hover:text-primary"
              >
                <div className="flex items-center gap-3">
                  <item.icon className="h-4 w-4 transition-transform group-hover:scale-110" />
                  {item.label}
                </div>
                <ChevronRight className="h-3 w-3 opacity-0 -translate-x-2 transition-all group-hover:opacity-100 group-hover:translate-x-0" />
              </Link>
            ))}
          </nav>

          <div className="p-4 mt-auto">
            <div className="rounded-2xl border border-border bg-card/50 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-secondary flex items-center justify-center border border-border">
                  <User className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="truncate text-xs font-semibold text-foreground">{user?.name || 'User Name'}</p>
                  <p className="text-[10px] text-muted-foreground capitalize">{user?.role || 'Operator'}</p>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden bg-background">
          <header className="glass-header sticky top-0 z-10">
            <div className="mx-auto flex h-24 max-w-7xl items-center justify-between px-8">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
                {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
              </div>
              <div className="flex items-center gap-4">{actions}</div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto max-w-7xl p-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
