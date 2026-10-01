'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Database, Globe2, LayoutGrid, List, Plus, RefreshCw, Search } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { StatusDot, type DeployStatus } from '@/components/synergy/status'
import { roleLabels } from '@/components/app/section'
import { roleIcons } from '@/components/app/stack-panel'
import { AppsView } from '@/components/projects/apps-view'
import { relativeTime } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface ProjectApp { id: string; name: string; component_role: string; environment: 'production' | 'staging'; project_type: string; setup_required: boolean; deployment_status: DeployStatus | null; deployed_at: string | null; is_active: boolean }
interface Project { id: string; name: string; apps: ProjectApp[]; database_count: number; domains: string[] }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<'projects' | 'apps'>('projects')
  const [appsSummary, setAppsSummary] = useState('Loading…')

  const load = async () => {
    setError('')
    try {
      const response = await fetch('/api/groups', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not load projects')
      setProjects(body.projects)
      setNow(Date.now())
    } catch (err) { setError((err as Error).message); setProjects(current => current || []) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'apps') setView('apps')
  }, [])
  const changeView = (next: 'projects' | 'apps') => {
    setView(next)
    window.history.replaceState(null, '', next === 'apps' ? '?view=apps' : '/projects')
  }

  const visible = useMemo(() => (projects || []).filter(project => {
    const q = search.trim().toLowerCase()
    return !q || project.name.toLowerCase().includes(q) || project.apps.some(app => app.name.toLowerCase().includes(q)) || project.domains.some(domain => domain.includes(q))
  }), [projects, search])

  const appCount = (projects || []).reduce((sum, project) => sum + project.apps.filter(app => app.environment === 'production').length, 0)

  return (
    <AppShell
      title="Projects"
      subtitle={view === 'apps' ? appsSummary : projects ? `${projects.length} projects · ${appCount} apps` : 'Everything you ship, grouped by product.'}
      actions={<>
        {view === 'projects' && <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button>}
        <Button asChild size="sm"><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}
      <div className="mb-5 flex h-9 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="View">
        {([['projects', 'Projects', LayoutGrid], ['apps', 'Apps', List]] as const).map(([value, label, Icon]) => (
          <button key={value} type="button" onClick={() => changeView(value)} aria-pressed={view === value} className={cn('flex h-full items-center gap-1.5 rounded-[5px] px-3 text-[13px]', view === value ? 'bg-white/[0.09]' : 'text-muted-foreground hover:text-foreground')}><Icon className="h-3.5 w-3.5" />{label}</button>
        ))}
      </div>

      {view === 'apps' ? <AppsView onSummary={setAppsSummary} /> : <>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input aria-label="Search projects" className="control-input pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects, apps or domains…" />
        </div>
      </div>

      {projects === null ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-52 animate-pulse rounded-[10px] border border-border bg-card" />)}</div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border"><Boxes className="h-5 w-5 text-muted-foreground" /></span>
          <h2 className="text-base font-medium">{projects.length ? 'No matching projects' : 'Add your first app'}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{projects.length ? 'Try a different search.' : 'Import a repository. Add its backend, database and domain to the same project as you go.'}</p>
          {!projects.length && <Button asChild size="sm" className="mt-5"><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map(project => {
            const production = project.apps.filter(app => app.environment === 'production')
            const staging = project.apps.length - production.length
            const latest = [...project.apps].filter(app => app.deployed_at).sort((a, b) => Date.parse(b.deployed_at!) - Date.parse(a.deployed_at!))[0]
            const failing = production.filter(app => app.deployment_status === 'failed').length
            const building = project.apps.some(app => app.deployment_status === 'running' || app.deployment_status === 'queued')
            return (
              <article key={project.id} className={cn('syn-tile group flex flex-col p-5', building && 'border-white/15')}>
                {building && <span className="spectrum-flow absolute inset-x-0 top-0 h-[2px] rounded-t-[10px]" aria-hidden="true" />}
                <Link href={`/projects/${project.id}`} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open project ${project.name}`} />
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold tracking-tight">{project.name}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{production.length} {production.length === 1 ? 'app' : 'apps'}{staging ? ` · ${staging} staging` : ''}{latest ? ` · updated ${relativeTime(latest.deployed_at, now)}` : ''}</p>
                  </div>
                  <div className="flex -space-x-2">{production.slice(0, 4).map(app => <span key={app.id} className="rounded-full ring-2 ring-card"><FrameworkAvatar type={app.project_type} size="sm" /></span>)}</div>
                </div>
                <div className="mt-4 space-y-1.5">
                  {production.slice(0, 4).map(app => {
                    const Icon = roleIcons[app.component_role] || Boxes
                    return (
                      <div key={app.id} className="flex items-center gap-2 text-[13px]">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{app.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{roleLabels[app.component_role]}</span>
                        <span className="ml-auto flex shrink-0 items-center">{app.setup_required ? <span className="text-[11px] text-amber-200">Setup</span> : app.deployment_status ? <StatusDot status={app.deployment_status} className="scale-75" /> : <span className="text-[11px] text-muted-foreground">New</span>}</span>
                      </div>
                    )
                  })}
                  {production.length > 4 && <p className="text-xs text-muted-foreground">+{production.length - 4} more</p>}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground" style={{ marginTop: 16 }}>
                  <span className="flex min-w-0 items-center gap-1.5"><Globe2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{project.domains[0] || 'No domain'}</span>{project.domains.length > 1 && <span>+{project.domains.length - 1}</span>}</span>
                  <span className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{project.database_count || 'No'} {project.database_count === 1 ? 'database' : 'databases'}</span>
                  {failing > 0 && <span className="text-status-failed">{failing} failing</span>}
                </div>
              </article>
            )
          })}
        </div>
      )}
      </>}
    </AppShell>
  )
}
