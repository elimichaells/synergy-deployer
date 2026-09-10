'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'

import {
  Boxes,
  ExternalLink,
  Plus,
  RefreshCw,
  Rocket,
  GitBranch,
  Folder,
  Activity,
  ChevronRight,
  Terminal,
  ArrowUpRight,
  Monitor,
  Server,
  Network,
  Search,
  Pin
} from 'lucide-react'

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

function FrameworkLogo({ type }: { type: Project['project_type'] }) {
  if (type === 'angular') return <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true"><path fill="#dd0031" d="M16 2 29 6.7 27 23.8 16 30 5 23.8 3 6.7Z" /><path fill="#fff" d="m16 6-7.2 16h3.6l1.45-3.6h4.3L19.6 22h3.6Zm0 5.1 1.15 4.2h-2.3Z" /></svg>
  if (type === 'next') return <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="#fff" /><path fill="#050505" d="M10 9h3.2l8.7 13.5V9H25v14.5h-3.2L13.1 10v13.5H10Z" /></svg>
  if (type === 'node') return <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true"><path fill="#5fa04e" d="m16 2.5 12 6.8v13.4l-12 6.8-12-6.8V9.3Z" /><text x="16" y="19" textAnchor="middle" fill="white" fontSize="9" fontWeight="700">JS</text></svg>
  if (type === 'laravel') return <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="6" fill="#ff2d20" /><path d="M10 8v12.5L16.5 24l6-3.5V14l-6 3.4-3-1.7V8Z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" /></svg>
  return <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true"><rect x="2" y="7" width="28" height="18" rx="9" fill="#00add8" /><text x="16" y="20" textAnchor="middle" fill="white" fontSize="10" fontWeight="800" fontStyle="italic">GO</text></svg>
}

interface Deployment {
  id: string
  project_id: string
  project_name: string
  status: 'queued' | 'running' | 'success' | 'failed'
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
  log: string | null
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

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

  const canWrite = user?.role === 'admin' || user?.role === 'operator'

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

  const latestDeployments = useMemo(() => deployments.slice(0, 10), [deployments])

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

  // Stats
  const totalSites = projects.length
  const activeSites = projects.filter(p => p.is_active).length
  const stagingSites = projects.filter(p => p.environment === 'staging').length
  const prodSites = projects.filter(p => p.environment === 'production').length
  const pinnedProjects = filteredProjects.filter(project => project.pinned)
  const otherProjects = filteredProjects.filter(project => !project.pinned)

  const renderProjectRow = (project: Project) => {
    const latest = activeDeployments.get(project.id) || deployments.find(deployment => deployment.project_id === project.id)
    const busy = activeDeployments.has(project.id) || deployingId === project.id
    const deployTone = project.setup_required ? 'text-amber-300' : busy ? 'text-sky-300' : latest?.status === 'failed' ? 'text-red-300' : latest?.status === 'success' ? 'text-emerald-300' : 'text-muted-foreground'
    const emptyAction = <span aria-hidden="true" className="hidden h-7 w-7 sm:block" />
    return <article key={project.id} className={`group grid h-12 min-w-0 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-2 transition-colors sm:grid-cols-[32px_minmax(0,1fr)_68px_176px] hover:border-sky-400/25 hover:bg-white/[0.04] ${project.pinned ? 'border-amber-300/15 bg-amber-300/[0.025]' : 'border-white/[0.06] bg-white/[0.018]'}`}>
      <Link href={`/sites/${project.id}${project.setup_required ? '?tab=setup' : ''}`} className="flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.035]" title={`${project.project_type} application`} aria-label={`Open ${project.name}, ${project.project_type} application`}><FrameworkLogo type={project.project_type} /></Link>
      <div className="min-w-0 self-center">
        <div className="flex min-w-0 items-center gap-1.5"><Link href={`/sites/${project.id}${project.setup_required ? '?tab=setup' : ''}`} className="truncate text-xs font-semibold hover:text-sky-300">{project.name}</Link><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${project.is_active ? 'bg-emerald-400' : 'bg-slate-600'}`} title={project.is_active ? 'Online' : 'Offline'} /></div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground"><span className={project.environment === 'production' ? 'text-emerald-300' : 'text-amber-300'}>{project.environment}</span><span>·</span><span className="capitalize">{project.project_type}</span><span>·</span><span className="font-mono">:{project.port || '—'}</span><span className="hidden truncate 2xl:inline">· {project.default_branch}</span></div>
      </div>
      <Link href={`/sites/${project.id}?tab=${project.setup_required ? 'setup' : 'deployments'}`} className={`hidden w-[68px] truncate text-[10px] font-medium capitalize sm:block ${deployTone}`}>{project.setup_required ? 'Setup' : latest ? latest.status === 'success' ? 'Deployed' : latest.status : 'Not deployed'}</Link>
      <div className="grid shrink-0 grid-cols-2 items-center justify-end gap-0.5 sm:grid-cols-6">
        <button onClick={() => void handlePin(project)} disabled={pinBusyId === project.id} className={`h-7 w-7 rounded p-1.5 transition-colors ${project.pinned ? 'text-amber-300' : 'text-muted-foreground/45 hover:bg-white/[0.06] hover:text-white'}`} title={project.pinned ? 'Unpin application' : 'Pin application'} aria-label={`${project.pinned ? 'Unpin' : 'Pin'} ${project.name}`}><Pin className={`h-3.5 w-3.5 ${project.pinned ? 'fill-current' : ''}`} /></button>
        <button onClick={() => void handleAutoDeploy(project)} disabled={!canWrite || autoDeployBusyId === project.id || project.setup_required} className={`hidden h-7 w-7 rounded p-1.5 transition-colors disabled:opacity-30 sm:block ${project.auto_deploy ? 'text-emerald-300' : 'text-muted-foreground/45 hover:bg-white/[0.06] hover:text-white'}`} title={`Automatic deployment ${project.auto_deploy ? 'on' : 'off'}`} aria-label={`Turn automatic deployment ${project.auto_deploy ? 'off' : 'on'} for ${project.name}`}><Activity className="h-3.5 w-3.5" /></button>
        {project.url ? <a href={project.url.startsWith('http') ? project.url : `https://${project.url}`} target="_blank" rel="noreferrer" className="hidden h-7 w-7 rounded p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-white sm:block" title="Open live application" aria-label={`Open live ${project.name}`}><ExternalLink className="h-3.5 w-3.5" /></a> : emptyAction}
        {project.environment === 'staging' ? <button title="Promote to production" aria-label={`Promote ${project.name}`} disabled={!canWrite || busy || project.setup_required || promotingId === project.id} onClick={() => void handlePromote(project.id)} className="hidden h-7 w-7 rounded p-1.5 text-amber-300 transition-colors hover:bg-white/[0.06] disabled:opacity-30 sm:block"><ArrowUpRight className="h-3.5 w-3.5" /></button> : emptyAction}
        <button title={project.setup_required ? 'Complete setup first' : 'Deploy'} aria-label={`Deploy ${project.name}`} disabled={!canWrite || busy || project.setup_required} onClick={() => void handleDeploy(project.id)} className="hidden h-7 w-7 rounded p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-30 sm:block"><Rocket className={`h-3.5 w-3.5 ${busy ? 'animate-pulse' : ''}`} /></button>
        <Link href={`/sites/${project.id}`} title="Open application workspace" aria-label={`Open ${project.name}`} className="h-7 w-7 rounded p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-white"><ChevronRight className="h-4 w-4" /></Link>
      </div>
    </article>
  }

  return <AppShell title="Applications" subtitle="Workspace / Applications" user={{ name: user?.name, role: user?.role }} actions={<div className="flex items-center gap-2"><Button variant="outline" size="icon" title="Refresh applications" aria-label="Refresh applications" onClick={() => void refresh()}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button><Button asChild disabled={!canWrite}><Link href="/sites/new"><Plus className="mr-2 h-4 w-4" />New application</Link></Button></div>}>
    {error && <div role="alert" className="notice-error">{error}</div>}

    <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {[['Applications', totalSites], ['Pinned', projects.filter(p => p.pinned).length], ['Online', activeSites], ['Production', prodSites], ['Staging', stagingSites]].map(([label, count]) => <div key={label} className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"><p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tracking-tight">{count}</p></div>)}
    </div>

    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2">
      <div className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input aria-label="Search applications" className="control-input h-9 border-0 bg-transparent pl-9 shadow-none" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="Search applications or repositories..." /></div>
      <label className="sr-only" htmlFor="environment-filter">Environment</label><select id="environment-filter" className="control-input h-9 w-40" value={environmentFilter} onChange={event => setEnvironmentFilter(event.target.value)}><option value="all">All environments</option><option value="production">Production</option><option value="staging">Staging</option><option value="draft">Setup incomplete</option></select>
      <Button variant="ghost" size="sm" onClick={handleDiscover} disabled={!canWrite || discovering}>{discovering ? 'Importing…' : 'Import from host'}</Button>
    </div>

    {loading ? <div className="grid gap-3 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,1.35fr)]"><div className="h-48 animate-pulse rounded-xl bg-muted/40" /><div className="h-64 animate-pulse rounded-xl bg-muted/40" /></div> : filteredProjects.length === 0 ? <div className="rounded-xl border border-dashed border-border py-16 text-center"><Boxes className="mx-auto mb-4 h-8 w-8 text-muted-foreground" /><h2 className="text-base font-medium">{projects.length ? 'No matching applications' : 'No applications yet'}</h2><Button asChild variant="link" className="mt-3"><Link href="/sites/new">Create application</Link></Button></div> : <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.35fr)]">
      <section className="flex h-[560px] min-w-0 flex-col overflow-hidden rounded-xl border border-amber-300/10 bg-amber-300/[0.012] p-2">
        <div className="mb-1.5 flex shrink-0 items-center justify-between border-b border-amber-300/10 px-1 pb-2 pt-1"><div className="flex items-center gap-2"><Pin className="h-3.5 w-3.5 fill-amber-300 text-amber-300" /><h2 className="text-xs font-semibold">Pinned</h2></div><span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[10px] text-amber-200">{pinnedProjects.length}</span></div>
        <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto overscroll-contain pr-1">{pinnedProjects.length ? pinnedProjects.map(renderProjectRow) : <div className="rounded-lg border border-dashed border-white/[0.07] px-4 py-8 text-center text-xs text-muted-foreground"><Pin className="mx-auto mb-2 h-4 w-4 opacity-40" />Pin applications for quick access.</div>}</div>
      </section>
      <section className="flex h-[560px] min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.012] p-2">
        <div className="mb-1.5 flex shrink-0 items-center justify-between border-b border-white/[0.07] px-1 pb-2 pt-1"><h2 className="text-xs font-semibold">All other applications</h2><span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-muted-foreground">{otherProjects.length}</span></div>
        <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto overscroll-contain pr-1">{otherProjects.length ? otherProjects.map(renderProjectRow) : <div className="rounded-lg border border-dashed border-white/[0.07] px-4 py-8 text-center text-xs text-muted-foreground">All matching applications are pinned.</div>}</div>
      </section>
    </div>}
  </AppShell>
}
