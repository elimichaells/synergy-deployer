import { Boxes, Cpu, Database, Gauge, Globe2, HardDrive, MemoryStick, Rocket, Server, Settings, Workflow, Wrench } from 'lucide-react'

/** Top-level navigation. `matches` lists every route prefix a tab owns. */
export const navItems = [
  { href: '/', label: 'Overview', icon: Gauge, description: 'Workspace health', matches: ['/'] },
  { href: '/projects', label: 'Projects', icon: Boxes, description: 'Your apps, grouped by product', matches: ['/projects', '/sites'] },
  { href: '/storage', label: 'Storage', icon: Database, description: 'Every database your apps use', matches: ['/storage', '/data-services', '/database'] },
  { href: '/deployments', label: 'Deployments', icon: Rocket, description: 'Release history and logs', matches: ['/deployments'] },
  { href: '/infrastructure', label: 'Infrastructure', icon: Server, description: 'Server-level services (admins)', matches: ['/infrastructure', '/domains', '/services', '/automation'] },
  { href: '/settings', label: 'Settings', icon: Settings, description: 'Account, team and integrations', matches: ['/settings'] },
]

/** Server-level areas, shown in the Infrastructure side menu. */
export const infrastructureItems = [
  { href: '/domains', label: 'Domains & DNS', icon: Globe2, description: 'Cloudflare accounts and every public address' },
  { href: '/services', label: 'Processes', icon: Cpu, description: 'Running processes and the Caddy web server' },
  { href: '/infrastructure/memory', label: 'Memory', icon: MemoryStick, description: 'What uses the server\'s memory, warnings and limits' },
  { href: '/automation', label: 'Jobs & workers', icon: Workflow, description: 'Scheduled jobs and background workers' },
  { href: '/infrastructure/runtimes', label: 'Runtimes & tools', icon: Wrench, description: 'Node, PHP, Go, database engines and tools' },
]

export function isNavActive(pathname: string, matches: string[]) {
  return matches.some(prefix => prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`))
}
