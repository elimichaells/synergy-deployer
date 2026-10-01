'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowUpRight, Boxes, ExternalLink, GitBranch, LayoutGrid, List, MoreHorizontal, Pin, Plus, RefreshCw, Rocket, Search, Zap,
} from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { PipelineMini } from '@/components/synergy/pipeline'
import { StatusDot, statusMeta, type DeployStatus } from '@/components/synergy/status'
import { relativeTime, stagesFromPhase } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface Project {
  pinned?: boolean
  application_group_name?: string | null
  component_role?: string
  setup_required?: boolean
  id: string
  name: string
  slug: string
  repo_url: string | null
  default_branch: string
  root_path: string
  pm2_name: string
  port: number | null
  url: string | null
  auto_deploy: boolean
  github_connection_id: string | null
  github_connection_name: string | null
  github_account_login: string | null
  is_active: boolean
  environment: 'production' | 'staging'
  project_type: 'next' | 'angular' | 'go' | 'laravel' | 'node'
  production_id: string | null
  staging_id: string | null
  created_at: string
  updated_at: string
}

interface Deployment {
  id: string
  project_id: string
  project_name: string
  status: DeployStatus
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
  phase?: string | null
  log: string | null
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

const repoLabel = (repo: string | null) => repo ? repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') : null
const liveUrl = (url: string | null) => url ? (url.startsWith('http') ? url : `https://${url}`) : null
const menuItem = 'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground'

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [promotingId, setPromotingId] = useState<string | null>(null)
  const [autoDeployBusyId, setAutoDeployBusyId] = useState<string | null>(null)
  const [pinBusyId, setPinBusyId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [environmentFilter, setEnvironmentFilter] = useState('all')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [now, setNow] = useState(() => Date.now())

  const canWrite = user?.role === 'admin' || user?.role === 'operator'

  useEffect(() => {
    try { if (localStorage.getItem('synergy.apps.view') === 'list') setView('list') } catch { /* storage unavailable */ }
  }, [])
  const changeView = (next: 'grid' | 'list') => {
    setView(next)
    try { localStorage.setItem('synergy.apps.view', next) } catch { /* storage unavailable */ }
  }

  const refresh = async () => {
    setError(null)
    try {
      const [projectsRes, deploymentsRes, meRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/deployments'),
        fetch('/api/auth/me'),
      ])

      if (!projectsRes.ok) throw new Error('Failed to load sites')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')

      const projectsData = await projectsRes.json()
      const deploymentsData = await deploymentsRes.json()
      const meData = meRes.ok ? await meRes.json() : { user: null }

      setProjects(projectsData)
      setDeployments(deploymentsData)
      setUser(meData.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const controller = new AbortController()
    let polling = false
    const interval = setInterval(async () => {
      setNow(Date.now())
      if (polling || document.hidden) return
      polling = true
      try {
        const response = await fetch('/api/deployments', { signal: controller.signal })
        if (response.ok) {
          const current = await response.json()
          if (!controller.signal.aborted) setDeployments(current)
        }
      } catch {
        // Preserve the last known status if a background refresh fails.
      } finally {
        polling = false
      }
    }, 5000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [])

  const handleDeploy = async (id: string) => {
    if (!canWrite) return
    setError(null)
    setDeployingId(id)
    try {
      const res = await fetch(`/api/sites/${id}/deploy`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Deployment failed')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deployment failed')
    } finally {
      setDeployingId(null)
    }
  }

  const handlePromote = async (id: string) => {
    if (!canWrite) return
    setError(null)
    setPromotingId(id)
    try {
      const res = await fetch(`/api/sites/${id}/promote`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Promotion failed')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed')
    } finally {
      setPromotingId(null)
    }
  }

  const handleAutoDeploy = async (project: Project) => {
    if (!canWrite || autoDeployBusyId) return
    const nextValue = !project.auto_deploy
    setError(null)
    setAutoDeployBusyId(project.id)
    setProjects((current) => current.map((item) =>
      item.id === project.id ? { ...item, auto_deploy: nextValue } : item
    ))

    try {
      const res = await fetch(`/api/sites/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDeploy: nextValue }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to update auto deployment')
      }
    } catch (err) {
      setProjects((current) => current.map((item) =>
        item.id === project.id ? { ...item, auto_deploy: project.auto_deploy } : item
      ))
      setError(err instanceof Error ? err.message : 'Failed to update auto deployment')
    } finally {
      setAutoDeployBusyId(null)
    }
  }

  const handleDiscover = async () => {
    if (!canWrite) return
    setDiscovering(true)
    setError(null)
    try {
      const res = await fetch('/api/sites/discover', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Sync failed')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setDiscovering(false)
    }
  }

  const handlePin = async (project: Project) => {
    if (pinBusyId) return
    const pinned = !project.pinned
    setPinBusyId(project.id)
    setProjects(current => current.map(item => item.id === project.id ? { ...item, pinned } : item))
    try {
      const res = await fetch(`/api/sites/${project.id}/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to update pin')
      }
    } catch (err) {
      setProjects(current => current.map(item => item.id === project.id ? { ...item, pinned: project.pinned } : item))
      setError(err instanceof Error ? err.message : 'Failed to update pin')
    } finally { setPinBusyId(null) }
  }

  const activeDeployments = useMemo(() => {
    const active = new Map<string, Deployment>()
    for (const deployment of deployments) {
      if ((deployment.status === 'running' || deployment.status === 'queued') && !active.has(deployment.project_id)) {
        active.set(deployment.project_id, deployment)
      }
    }
    return active
  }, [deployments])

  const filteredProjects = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const priority = (id: string) => deployingId === id || activeDeployments.get(id)?.status === 'running' ? 2 : activeDeployments.has(id) ? 1 : 0
    const startedAt = (id: string) => Date.parse(activeDeployments.get(id)?.started_at || '') || 0
    return projects.filter(p =>
      (environmentFilter === 'all' || (environmentFilter === 'draft' ? p.setup_required : p.environment === environmentFilter)) && (
      p.name.toLowerCase().includes(q) ||
      p.pm2_name.toLowerCase().includes(q) ||
      p.application_group_name?.toLowerCase().includes(q) ||
      (p.repo_url && p.repo_url.toLowerCase().includes(q)))
    ).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || priority(b.id) - priority(a.id)
      || startedAt(b.id) - startedAt(a.id)
      || a.name.localeCompare(b.name))
  }, [projects, searchQuery, environmentFilter, activeDeployments, deployingId])

  const pinnedProjects = filteredProjects.filter(project => project.pinned)
  const otherProjects = filteredProjects.filter(project => !project.pinned)
  const counts = {
    all: projects.length,
    online: projects.filter(p => p.is_active).length,
    building: activeDeployments.size,
  }

  const projectState = (project: Project) => {
    const latest = activeDeployments.get(project.id) || deployments.find(deployment => deployment.project_id === project.id)
    const busy = activeDeployments.has(project.id) || deployingId === project.id
    return { latest, busy }
  }

  const actionsMenu = (project: Project, busy: boolean) => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="relative z-10 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground data-[state=open]:bg-white/[0.07]" aria-label={`Actions for ${project.name}`}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-56 rounded-lg border border-white/10 bg-popover p-1 shadow-2xl shadow-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <DropdownMenu.Item className={menuItem} disabled={!canWrite || busy || project.setup_required} onSelect={() => void handleDeploy(project.id)}><Rocket className="h-3.5 w-3.5" />{project.setup_required ? 'Finish setup to deploy' : 'Deploy now'}</DropdownMenu.Item>
          {project.environment === 'staging' && <DropdownMenu.Item className={menuItem} disabled={!canWrite || busy || project.setup_required || promotingId === project.id} onSelect={() => void handlePromote(project.id)}><ArrowUpRight className="h-3.5 w-3.5" />Promote to production</DropdownMenu.Item>}
          <DropdownMenu.Item className={menuItem} disabled={!canWrite || autoDeployBusyId === project.id || project.setup_required} onSelect={() => void handleAutoDeploy(project)}><Zap className="h-3.5 w-3.5" />{project.auto_deploy ? 'Turn off auto-deploy' : 'Turn on auto-deploy'}</DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} disabled={pinBusyId === project.id} onSelect={() => void handlePin(project)}><Pin className="h-3.5 w-3.5" />{project.pinned ? 'Unpin' : 'Pin to top'}</DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {liveUrl(project.url) && <DropdownMenu.Item asChild className={menuItem}><a href={liveUrl(project.url)!} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Visit</a></DropdownMenu.Item>}
          <DropdownMenu.Item asChild className={menuItem}><Link href={`/sites/${project.id}?tab=deployments`}><GitBranch className="h-3.5 w-3.5" />Deployment history</Link></DropdownMenu.Item>
          <DropdownMenu.Item asChild className={menuItem}><Link href={`/sites/${project.id}?tab=settings`}><Boxes className="h-3.5 w-3.5" />Settings</Link></DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )

  const deploymentLine = (project: Project, latest: Deployment | undefined, busy: boolean) => {
    if (project.setup_required) return <span className="text-amber-200">Setup incomplete — continue configuration</span>
    if (!latest) return <span>{busy ? 'Starting deployment…' : 'No deployments yet'}</span>
    const live = latest.status === 'running' || latest.status === 'queued'
    const activeStage = live ? stagesFromPhase(latest.status, latest.phase, latest.log).find(stage => stage.state === 'active') : null
    return (
      <span className="flex min-w-0 items-center gap-2">
        <StatusDot status={latest.status} className="scale-90" />
        <span className={cn('shrink-0', statusMeta[latest.status].text)}>{activeStage ? activeStage.label : statusMeta[latest.status].label}</span>
        <span className="truncate">{latest.branch || project.default_branch}{latest.commit_sha ? ` · ${latest.commit_sha.slice(0, 7)}` : ''}</span>
        <span className="ml-auto shrink-0">{relativeTime(latest.finished_at || latest.started_at, now)}</span>
      </span>
    )
  }

  const renderCard = (project: Project) => {
    const { latest, busy } = projectState(project)
    const live = latest && (latest.status === 'running' || latest.status === 'queued')
    const href = `/sites/${project.id}${project.setup_required ? '?tab=setup' : ''}`
    return (
      <article key={project.id} className={cn('syn-tile group flex min-h-[176px] flex-col p-5', live && 'border-white/15')}>
        {live && <span className="spectrum-flow absolute inset-x-0 top-0 h-[2px] rounded-t-[10px]" aria-hidden="true" />}
        <Link href={href} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open ${project.name}`} />
        <div className="flex items-start gap-3">
          <FrameworkAvatar type={project.project_type} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold tracking-tight">{project.name}</h3>
              {project.pinned && <Pin className="h-3 w-3 shrink-0 fill-current text-muted-foreground" aria-label="Pinned" />}
            </div>
            {liveUrl(project.url)
              ? <a href={liveUrl(project.url)!} target="_blank" rel="noreferrer" className="relative z-10 block truncate text-[13px] text-muted-foreground hover:text-foreground hover:underline">{project.url!.replace(/^https?:\/\//, '')}</a>
              : <p className="truncate text-[13px] text-muted-foreground">{project.port ? `localhost:${project.port}` : project.pm2_name}</p>}
          </div>
          {actionsMenu(project, busy)}
        </div>

        {repoLabel(project.repo_url) && (
          <p className="mt-4 flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-white/[0.03] px-2.5 py-1 text-xs font-medium">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
            <span className="truncate">{repoLabel(project.repo_url)}</span>
          </p>
        )}

        <div className="mt-auto pt-4">
          {live && latest && <PipelineMini stages={stagesFromPhase(latest.status, latest.phase, latest.log)} className="mb-2.5" />}
          <div className="text-xs text-muted-foreground">{deploymentLine(project, latest, busy)}</div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-full border px-2 py-px text-[11px] font-medium', project.environment === 'production' ? 'border-sky-400/25 text-sky-300' : 'border-amber-300/25 text-amber-200')}>{project.environment === 'production' ? 'Production' : 'Staging'}</span>
            {project.auto_deploy && <span className="flex items-center gap-1 rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground"><Zap className="h-3 w-3" />Auto-deploy</span>}
            {project.application_group_name && <span className="truncate rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">{project.application_group_name}</span>}
            <span className={cn('ml-auto flex items-center gap-1.5 text-[11px]', project.is_active ? 'text-muted-foreground' : 'text-muted-foreground/60')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', project.is_active ? 'bg-status-ready' : 'bg-white/25')} />{project.is_active ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
      </article>
    )
  }

  const renderRow = (project: Project) => {
    const { latest, busy } = projectState(project)
    const href = `/sites/${project.id}${project.setup_required ? '?tab=setup' : ''}`
    return (
      <div key={project.id} className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-white/[0.025] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_120px_auto]">
        <Link href={href} className="absolute inset-0 z-0" aria-label={`Open ${project.name}`} />
        <div className="flex min-w-0 items-center gap-3">
          <FrameworkAvatar type={project.project_type} size="sm" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate text-sm font-medium">{project.name}{project.pinned && <Pin className="h-3 w-3 fill-current text-muted-foreground" />}</p>
            <p className="truncate text-xs text-muted-foreground">{project.url?.replace(/^https?:\/\//, '') || (project.port ? `localhost:${project.port}` : project.pm2_name)}</p>
          </div>
        </div>
        <div className="hidden min-w-0 text-xs text-muted-foreground md:block">{deploymentLine(project, latest, busy)}</div>
        <span className={cn('hidden w-fit rounded-full border px-2 py-px text-[11px] font-medium md:inline', project.environment === 'production' ? 'border-sky-400/25 text-sky-300' : 'border-amber-300/25 text-amber-200')}>{project.environment === 'production' ? 'Production' : 'Staging'}</span>
        {actionsMenu(project, busy)}
      </div>
    )
  }

  const renderGroup = (title: string, items: Project[]) => items.length > 0 && (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">{title === 'Pinned' && <Pin className="h-3.5 w-3.5" />}{title}<span className="text-xs text-muted-foreground/60">{items.length}</span></h2>
      {view === 'grid'
        ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map(renderCard)}</div>
        : <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{items.map(renderRow)}</div>}
    </section>
  )

  return (
    <AppShell
      title="Applications"
      subtitle={loading ? 'Loading…' : `${counts.all} applications · ${counts.online} online${counts.building ? ` · ${counts.building} building` : ''}`}
      user={{ name: user?.name, role: user?.role }}
      actions={<>
        <Button variant="outline" size="sm" onClick={() => void handleDiscover()} disabled={!canWrite || discovering}>{discovering ? 'Importing…' : 'Import from host'}</Button>
        <Button asChild size="sm" disabled={!canWrite}><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />Add New…</Link></Button>
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input aria-label="Search applications" className="control-input pl-9" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search applications, processes or repositories…" />
        </div>
        <label className="sr-only" htmlFor="environment-filter">Environment</label>
        <select id="environment-filter" className="control-input w-auto min-w-[170px]" value={environmentFilter} onChange={event => setEnvironmentFilter(event.target.value)}>
          <option value="all">All environments</option>
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="draft">Setup incomplete</option>
        </select>
        <div className="flex h-9 items-center rounded-md border border-border p-0.5" role="group" aria-label="Layout">
          <button type="button" onClick={() => changeView('grid')} aria-pressed={view === 'grid'} aria-label="Grid view" className={cn('flex h-full w-8 items-center justify-center rounded-[5px]', view === 'grid' ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}><LayoutGrid className="h-4 w-4" /></button>
          <button type="button" onClick={() => changeView('list')} aria-pressed={view === 'list'} aria-label="List view" className={cn('flex h-full w-8 items-center justify-center rounded-[5px]', view === 'list' ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}><List className="h-4 w-4" /></button>
        </div>
        <Button variant="outline" size="icon" title="Refresh applications" aria-label="Refresh applications" onClick={() => void refresh()}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></Button>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map(i => <div key={i} className="h-[176px] animate-pulse rounded-[10px] border border-border bg-card" />)}</div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border"><Boxes className="h-5 w-5 text-muted-foreground" /></span>
          <h2 className="text-base font-medium">{projects.length ? 'No matching applications' : 'Deploy your first application'}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{projects.length ? 'Try a different search or environment.' : 'Connect a GitHub repository and Synergy will build, verify and serve it on this host.'}</p>
          {!projects.length && <Button asChild size="sm" className="mt-5"><Link href="/sites/new"><Plus className="mr-1.5 h-4 w-4" />New application</Link></Button>}
        </div>
      ) : (
        <>
          {renderGroup('Pinned', pinnedProjects)}
          {renderGroup(pinnedProjects.length ? 'All applications' : 'Applications', otherProjects)}
        </>
      )}
    </AppShell>
  )
}
