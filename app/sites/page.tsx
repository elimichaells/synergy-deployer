'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
  LayoutList,
  LayoutGrid
} from 'lucide-react'

interface Project {
  id: string
  name: string
  slug: string
  repo_url: string | null
  default_branch: string
  root_path: string
  pm2_name: string
  port: number | null
  url: string | null
  is_active: boolean
  environment: 'production' | 'staging'
  production_id: string | null
  staging_id: string | null
  created_at: string
  updated_at: string
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
  const [searchQuery, setSearchQuery] = useState('')

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

  const latestDeployments = useMemo(() => deployments.slice(0, 10), [deployments])

  const filteredProjects = useMemo(() => {
    if (!searchQuery) return projects
    const q = searchQuery.toLowerCase()
    return projects.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.pm2_name.toLowerCase().includes(q) ||
      (p.repo_url && p.repo_url.toLowerCase().includes(q))
    )
  }, [projects, searchQuery])

  // Stats
  const totalSites = projects.length
  const activeSites = projects.filter(p => p.is_active).length
  const stagingSites = projects.filter(p => p.environment === 'staging').length
  const prodSites = projects.filter(p => p.environment === 'production').length

  return (
    <AppShell
      title="Dashboard"
      subtitle="Overview of your application ecosystem."
      user={{ name: user?.name, role: user?.role }}
      actions={
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search sites..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-64 rounded-lg bg-secondary/50 pl-9 pr-4 text-sm outline-none focus:ring-1 focus:ring-primary/50 transition-all"
            />
          </div>
          <div className="h-6 w-px bg-border/40 mx-1" />
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleDiscover}
            disabled={!canWrite || discovering}
            className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${discovering ? 'animate-spin' : ''}`} />
            Sync Host
          </button>
          <Link href="/sites/new">
            <button
              disabled={!canWrite}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 shadow-[0_0_15px_hsl(199_89%_48%/0.3)]"
            >
              <Plus className="h-3.5 w-3.5" />
              New Site
            </button>
          </Link>
        </div>
      }
    >
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
          {error}
        </div>
      )}

      {/* Hero Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Total Sites</span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{totalSites}</span>
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Active Services</span>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-emerald-500">{activeSites}</span>
            <span className="text-sm font-medium text-muted-foreground">/ {totalSites}</span>
          </div>
          <div className="w-full bg-secondary h-1 rounded-full mt-2 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${(activeSites / (totalSites || 1)) * 100}%` }} />
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">Environments</span>
          <div className="flex items-center gap-4 mt-1">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-blue-400" />
              <span className="text-sm font-bold">{prodSites}</span>
              <span className="text-xs text-muted-foreground">Prod</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-sm font-bold">{stagingSites}</span>
              <span className="text-xs text-muted-foreground">Staging</span>
            </div>
          </div>
        </div>
        <div className="surface-card p-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase font-bold text-muted-foreground/60">System Health</span>
          <div className="flex items-center gap-2 mt-1">
            <Activity className="h-5 w-5 text-emerald-500" />
            <span className="text-sm font-medium text-emerald-500">Operational</span>
          </div>
          <span className="text-[10px] text-muted-foreground mt-0.5">All systems normal</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-8">
        {/* Main List */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <LayoutList className="h-4 w-4" /> Applications
            </h3>
            <span className="text-xs text-muted-foreground font-mono">
              {filteredProjects.length} / {totalSites} sites
            </span>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-16 w-full animate-pulse rounded-xl bg-card/50 border border-border" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Table Header */}
              <div className="hidden md:grid grid-cols-[2fr_120px_1.5fr_1fr_140px] gap-4 px-6 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                <div>Name</div>
                <div>Environment</div>
                <div>Branch / Repo</div>
                <div>Process</div>
                <div className="text-right">Actions</div>
              </div>

              {filteredProjects.map(project => (
                <div
                  key={project.id}
                  className="group relative grid grid-cols-1 md:grid-cols-[2fr_120px_1.5fr_1fr_140px] items-center gap-4 rounded-xl border border-border/40 bg-card/30 p-4 transition-all hover:border-primary/30 hover:bg-card/60 hover:shadow-lg hover:shadow-black/20"
                >
                  {/* Name & Status */}
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${project.is_active ? 'bg-emerald-500 shadow-[0_0_8px_hsl(141_76%_36%/0.6)]' : 'bg-muted-foreground'}`} />
                    <div className="flex flex-col min-w-0">
                      <Link
                        href={`/sites/${project.id}`}
                        className="font-bold text-sm hover:text-primary transition-colors truncate"
                      >
                        {project.name}
                      </Link>
                      {project.url && (
                        <a href={project.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted-foreground hover:text-foreground truncate flex items-center gap-1">
                          {project.url.replace(/^https?:\/\//, '')} <ExternalLink className="h-2.5 w-2.5 inline" />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* Environment */}
                  <div>
                    <Badge variant="outline" className={`text-[10px] uppercase font-bold px-2 py-0 h-5 border-none ${project.environment === 'staging'
                        ? 'text-amber-400 bg-amber-400/10'
                        : 'text-blue-400 bg-blue-400/10'
                      }`}>
                      {project.environment}
                    </Badge>
                  </div>

                  {/* Branch / Repo */}
                  <div className="flex flex-col text-xs text-muted-foreground min-w-0">
                    <div className="flex items-center gap-1.5 text-foreground/80 font-medium">
                      <GitBranch className="h-3 w-3 text-muted-foreground/70" />
                      <span className="truncate">{project.default_branch}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] truncate opacity-70">
                      <Folder className="h-3 w-3" />
                      <span className="truncate">{project.repo_url?.split('/').slice(-2).join('/') || 'No Repo'}</span>
                    </div>
                  </div>

                  {/* Process Info */}
                  <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                    <Terminal className="h-3 w-3 opacity-50" />
                    <span className="truncate">{project.pm2_name}</span>
                    {project.port && (
                      <span className="px-1.5 py-0.5 rounded bg-secondary/50 text-[10px] font-bold text-foreground/70">:{project.port}</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    {project.environment === 'staging' && (
                      <button
                        onClick={() => handlePromote(project.id)}
                        disabled={!canWrite || promotingId === project.id}
                        className="h-7 w-7 flex items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500 hover:text-white transition-all disabled:opacity-50"
                        title="Promote to Production"
                      >
                        <ArrowUpRight className={`h-3.5 w-3.5 ${promotingId === project.id ? 'animate-bounce' : ''}`} />
                      </button>
                    )}

                    <button
                      onClick={() => handleDeploy(project.id)}
                      disabled={!canWrite || deployingId === project.id}
                      className="h-7 w-7 flex items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-all disabled:opacity-50"
                      title="Deploy"
                    >
                      <Rocket className={`h-3.5 w-3.5 ${deployingId === project.id ? 'animate-bounce' : ''}`} />
                    </button>

                    <Link
                      href={`/sites/${project.id}`}
                      className="h-7 w-7 flex items-center justify-center rounded-lg bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-all"
                      title="Details"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>
              ))}

              {filteredProjects.length === 0 && (
                <div className="py-20 text-center border-2 border-dashed border-border rounded-3xl opacity-50 flex flex-col items-center justify-center">
                  <Search className="h-10 w-10 mb-4 opacity-20" />
                  <p className="text-sm font-medium">No sites match your search.</p>
                  {projects.length === 0 && (
                    <p className="text-xs text-muted-foreground mt-1">Try syncing from host or create a new site.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Activity Sidebar */}
        <div>
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Recent Activity</h3>
            <Link href="/deployments" className="text-[10px] font-bold text-primary hover:text-primary/80 transition-colors">
              VIEW ALL
            </Link>
          </div>

          <div className="space-y-4">
            {latestDeployments.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-xl">
                No recent activity.
              </div>
            ) : (
              <div className="relative border-l border-border/40 ml-3 space-y-6">
                {latestDeployments.map((deployment) => (
                  <div key={deployment.id} className="relative pl-6">
                    <div className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background ${deployment.status === 'success' ? 'bg-emerald-500' :
                        deployment.status === 'failed' ? 'bg-destructive' : 'bg-blue-500 animate-pulse'
                      }`} />

                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {deployment.finished_at ? new Date(deployment.finished_at).toLocaleString() : 'Running...'}
                      </span>
                      <p className="text-sm font-medium leading-none">{deployment.project_name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="secondary" className="text-[9px] h-4 px-1 rounded-sm font-normal text-muted-foreground">
                          {deployment.branch || 'main'}
                        </Badge>
                        <span className="text-[10px] font-mono text-muted-foreground/50">
                          {deployment.commit_sha?.slice(0, 7) || '---'}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
