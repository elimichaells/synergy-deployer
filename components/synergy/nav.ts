import { serverOverview, serverScope } from '@/lib/server-navigation'
import { Boxes, Cpu, Database, Gauge, Globe2, HardDrive, MemoryStick, Rocket, Server, Settings, ShieldCheck, Workflow, Wrench } from 'lucide-react'

/** Top-level navigation. `matches` lists every route prefix a tab owns. */
export const navItems = [
  { href: '/', label: 'Servers', icon: Server, description: 'Choose a server workspace', matches: ['/'] },
  { href: '/overview', label: 'Overview', icon: Gauge, description: 'Manager host overview', matches: ['/overview'] },
  { href: '/projects', label: 'Projects', icon: Boxes, description: 'Your apps, grouped by product', matches: ['/projects', '/sites'] },
  { href: '/storage', label: 'Storage', icon: Database, description: 'Every database your apps use', matches: ['/storage', '/data-services', '/database'] },
  { href: '/deployments', label: 'Deployments', icon: Rocket, description: 'Release history and logs', matches: ['/deployments'] },
  { href: '/infrastructure', label: 'Infrastructure', icon: Server, description: 'Server-level services (admins)', matches: ['/infrastructure', '/domains', '/services', '/automation'] },
  { href: '/settings', label: 'Settings', icon: Settings, description: 'Account, team and integrations', matches: ['/settings'] },
]

export function workspaceNavItems(pathname: string) {
  const scope = serverScope(pathname)
  if (scope.kind === 'fleet') return [navItems[0], navItems[navItems.length - 1]]
  if (scope.kind === 'local') return navItems
  const href = serverOverview(scope.id)
  return [navItems[0],
    { href, label: 'Overview', icon: Gauge, description: 'This server’s health and activity', matches: [href] },
    { href: `${href}#applications`, label: 'Projects', icon: Boxes, description: 'Applications on this server', matches: [] },
    { href: `${href}#storage`, label: 'Storage', icon: Database, description: 'Application databases on this server', matches: [] },
    { href: `${href}#deployments`, label: 'Deployments', icon: Rocket, description: 'Deployments on this server', matches: [] },
    { href: `${href}#server-access`, label: 'Infrastructure', icon: Server, description: 'Agent access and connection', matches: [] },
    navItems[navItems.length - 1],
  ]
}

/** Server-level areas, shown in the Infrastructure side menu. */
export const infrastructureItems = [
  { href: '/infrastructure/servers', label: 'Servers', icon: Server, description: 'Windows and Linux servers, monitoring and remote deployments' },
  { href: '/infrastructure/operations', label: 'AI Operations', icon: ShieldCheck, description: 'Diagnosis, reviewed recovery and sampled uptime' },
  { href: '/infrastructure/health', label: 'Health & alerts', icon: Gauge, description: 'Disk, process and response warnings before an outage' },
  { href: '/domains', label: 'Domains & DNS', icon: Globe2, description: 'Cloudflare accounts and every public address' },
  { href: '/services', label: 'Processes', icon: Cpu, description: 'Running processes and the Caddy web server' },
  { href: '/infrastructure/memory', label: 'Memory', icon: MemoryStick, description: 'What uses the server\'s memory, warnings and limits' },
  { href: '/infrastructure/disk', label: 'Disk cleanup', icon: HardDrive, description: 'Release storage, protected rollback copies and automatic cleanup' },
  { href: '/automation', label: 'Jobs & workers', icon: Workflow, description: 'Scheduled jobs and background workers' },
  { href: '/infrastructure/runtimes', label: 'Runtimes & tools', icon: Wrench, description: 'Node, PHP, Go, database engines and tools' },
]

export function isNavActive(pathname: string, matches: string[]) {
  return matches.some(prefix => prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** The infrastructure layout is shared; links always retain the server URL. */
export function workspaceInfrastructureItems(pathname: string) {
  const scope = serverScope(pathname)
  if (scope.kind !== 'remote') return infrastructureItems
  const root = serverOverview(scope.id)
  return [
    { href: `${root}?section=health#server-access`, label: 'Health & alerts', icon: Gauge, description: 'Reported CPU, memory, disk and connection health' },
    { href: `${root}#domains`, label: 'Domains & DNS', icon: Globe2, description: 'Application hostnames, IP access and Caddy HTTPS' },
    { href: `${root}?section=processes#server-access`, label: 'Processes', icon: Cpu, description: 'Application processes reported by this server' },
    { href: `${root}?section=runtimes#server-access`, label: 'Runtimes & tools', icon: Wrench, description: 'Installed tools reported by the agent' },
    { href: `${root}?section=agent#server-access`, label: 'Agent access & updates', icon: ShieldCheck, description: 'Connection, safe agent updates and enrollment' },
  ]
}
