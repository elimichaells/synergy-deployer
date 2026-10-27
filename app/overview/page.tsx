'use client'

import { AppShell } from '@/components/layout/app-shell'
import { useServerHealth } from '@/components/server-health'
import { type DeploymentSummary } from '@/components/synergy/deployment-row'
import { Button } from '@/components/ui/button'
import { ServerOverviewContent } from '@/components/workspace/server-overview'
import { applicationHealthLabels, applicationState } from '@/lib/application-health'
import { cn } from '@/lib/utils'
import { Globe2, Plus, RefreshCw, Workflow } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

interface Project {
  id: string
  name: string
  pm2_name: string
  is_active: boolean
  project_type: string
  environment: 'production' | 'staging'
  url: string | null
  port: number | null
  setup_required?: boolean
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

export default function Dashboard() {
  const { health, error: healthError } = useServerHealth()
  const [projects, setProjects] = useState<Project[]>([])
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setError(null)
    try {
      const [projectsRes, deploymentsRes, meRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/deployments?limit=100', { cache: 'no-store' }),
        silent ? Promise.resolve(null) : fetch('/api/auth/me'),
      ])

      if (!projectsRes.ok) throw new Error('Failed to load projects')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')

      setProjects(await projectsRes.json())
      setDeployments(await deploymentsRes.json())
      if (meRes?.ok) setUser((await meRes.json()).user)
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const poll = window.setInterval(() => { if (!document.hidden) void refresh(true) }, 8_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(poll); window.clearInterval(clock) }
  }, [refresh])

  const greeting = new Date(now).getHours() < 12 ? 'Good morning' : new Date(now).getHours() < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <AppShell
      title={user?.name ? `${greeting}, ${user.name.split(' ')[0]}` : 'Overview'}
      subtitle="Manager host · applications, deployments and health."
      user={{ name: user?.name, role: user?.role }}
      actions={<>
        <Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</Button>
        <Button asChild size="sm"><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      <ServerOverviewContent projects={projects.map(project => ({ ...project, href: `/sites/${project.id}`, readiness: applicationState(healthError ? null : health, project.pm2_name), statusLabel: applicationHealthLabels[applicationState(healthError ? null : health, project.pm2_name)] }))}
        deployments={deployments} now={now} loading={loading} healthHint={healthError || !health || health.stale ? 'Health unknown' : `${projects.filter(p => applicationState(health, p.pm2_name) === 'ready').length} readiness checks passed`}
        projectsHref="/projects" deploymentsHref="/deployments" shortcuts={[
          { href: '/sites/new', icon: Plus, title: 'Import a repository', hint: 'Build, verify and serve a new app' },
          { href: '/domains', icon: Globe2, title: 'Connect a domain', hint: 'Cloudflare DNS and automatic TLS' },
          { href: '/automation', icon: Workflow, title: 'Schedule a job', hint: 'Cron jobs and background workers' },
        ]} />
    </AppShell>
  )
}
