import { Boxes, Database, Gauge, Globe2, HardDrive, Rocket, Server, Settings, Workflow } from 'lucide-react'

export const navItems = [
  { href: '/', label: 'Overview', icon: Gauge, description: 'Workspace health' },
  { href: '/sites', label: 'Applications', icon: Boxes, description: 'Projects on this host' },
  { href: '/deployments', label: 'Deployments', icon: Rocket, description: 'Release history and logs' },
  { href: '/automation', label: 'Jobs & Workers', icon: Workflow, description: 'Cron jobs and workers' },
  { href: '/services', label: 'Processes', icon: Server, description: 'PM2 and Caddy' },
  { href: '/data-services', label: 'Data Services', icon: HardDrive, description: 'Database connections' },
  { href: '/database', label: 'PostgreSQL', icon: Database, description: 'Server and backups' },
  { href: '/domains', label: 'Domains', icon: Globe2, description: 'DNS and TLS' },
  { href: '/settings', label: 'Settings', icon: Settings, description: 'Host and integrations' },
]
