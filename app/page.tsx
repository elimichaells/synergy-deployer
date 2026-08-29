'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'
import {
  Activity,
  Boxes,
  Clock,
  ExternalLink,
  RefreshCw,
  Rocket
} from 'lucide-react'

interface Project {
  id: string
  name: string
  is_active: boolean
}

interface Deployment {
  id: string
  project_id: string
  project_name: string
  status: 'queued' | 'running' | 'success' | 'failed'
  branch: string | null
  commit_sha: string | null
}

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setError(null)
    try {
      const [projectsRes, deploymentsRes, meRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/deployments'),
        fetch('/api/auth/me'),
      ])

      if (!projectsRes.ok) throw new Error('Failed to load projects')
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

  const latestDeployments = useMemo(() => deployments.slice(0, 8), [deployments])

  return (
    <AppShell
      title="Overview"
      subtitle="Deployment and application health at a glance."
      user={{ name: user?.name, role: user?.role }}
      actions={
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-2 rounded-lg bg-primary/10 px-4 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      }
    >
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <div className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
          {error}
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-8">
          <section className="grid gap-6 md:grid-cols-3">
            <div className="surface-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="rounded-lg bg-blue-500/10 p-2 text-blue-500 border border-blue-500/20">
                  <Boxes className="h-5 w-5" />
                </div>
                <Badge variant="outline" className="text-[10px] uppercase font-bold text-muted-foreground border-border bg-muted/30">Infrastructure</Badge>
              </div>
              <div>
                <p className="text-3xl font-bold tracking-tight">{projects.length}</p>
                <p className="text-xs font-medium text-muted-foreground mt-1">Total Web Sites</p>
              </div>
            </div>

            <div className="surface-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-500 border border-emerald-500/20">
                  <Activity className="h-5 w-5" />
                </div>
                <Badge variant="outline" className="text-[10px] uppercase font-bold text-emerald-400 border-emerald-500/20 bg-emerald-500/10">Active</Badge>
              </div>
              <div>
                <p className="text-3xl font-bold tracking-tight">
                  {projects.filter((p) => p.is_active).length}
                </p>
                <p className="text-xs font-medium text-muted-foreground mt-1">Live Applications</p>
              </div>
            </div>

            <div className="surface-card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="rounded-lg bg-primary/10 p-2 text-primary border border-primary/20">
                  <Rocket className="h-5 w-5" />
                </div>
                <Badge variant="outline" className="text-[10px] uppercase font-bold text-muted-foreground border-border bg-muted/30">Last Event</Badge>
              </div>
              <div>
                <p className="text-lg font-bold truncate">
                  {latestDeployments[0]?.project_name || 'Idle'}
                </p>
                <p className="text-xs font-medium text-muted-foreground mt-1">Latest Deployment</p>
              </div>
            </div>
          </section>

          <Card className="surface-card border-none bg-transparent shadow-none">
            <CardHeader className="px-0 pt-0">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-xl font-bold">Sites Snapshot</CardTitle>
                  <CardDescription className="text-muted-foreground">Quick access to your managed components.</CardDescription>
                </div>
                <Link href="/sites" className="text-xs font-semibold text-primary hover:underline flex items-center gap-1">
                  Manage all <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              {loading ? (
                <div className="flex flex-col gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 w-full animate-pulse rounded-2xl bg-card/50 border border-border" />
                  ))}
                </div>
              ) : (
                <div className="grid gap-3">
                  {projects.slice(0, 5).map((project) => (
                    <div key={project.id} className="surface-panel flex items-center justify-between p-4 px-6 hover:border-primary/30 transition-colors group">
                      <div className="flex items-center gap-4">
                        <div className="relative">
                          <div className={`h-2.5 w-2.5 rounded-full ${project.is_active ? 'bg-emerald-500 shadow-[0_0_8px_hsl(141_76%_36%/0.5)]' : 'bg-muted-foreground'}`} />
                          {project.is_active && (
                            <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-emerald-500 heartbeat opacity-50" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{project.name}</p>
                          <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Ready to deploy</p>
                        </div>
                      </div>
                      <Link
                        href={`/sites`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity rounded-lg bg-muted p-2 text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>


        <Card className="surface-card flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              <CardTitle className="text-lg">Recent Deployments</CardTitle>
            </div>
            <CardDescription className="text-muted-foreground">Latest CI/CD activity logs.</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 space-y-3">
            {latestDeployments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
                <Rocket className="h-8 w-8 opacity-10 mb-2" />
                <p className="text-xs">No recent activity detected.</p>
              </div>
            ) : (
              latestDeployments.map((deployment) => (
                <div key={deployment.id} className="surface-panel p-4 flex items-center justify-between border-transparent hover:border-border transition-all">
                  <div className="flex items-center gap-3">
                    <div className={`h-px w-6 ${deployment.status === 'success' ? 'bg-emerald-500' :
                      deployment.status === 'failed' ? 'bg-red-500' : 'bg-primary animate-pulse'
                      }`} />
                    <div>
                      <p className="text-xs font-bold">{deployment.project_name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {deployment.branch || 'main'} • <span className="font-mono">{deployment.commit_sha?.slice(0, 7)}</span>
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className={`text-[10px] px-2 py-0 border-none capitalize font-bold ${deployment.status === 'success' ? 'text-emerald-500 bg-emerald-500/10' :
                    deployment.status === 'failed' ? 'text-red-500 bg-red-500/10' :
                      'text-primary bg-primary/10 animate-pulse'
                    }`}>
                    {deployment.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
          <div className="p-6 pt-0 mt-auto">
            <Link
              href="/deployments"
              className="block w-full text-center rounded-xl bg-secondary py-2.5 text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
            >
              View Full History
            </Link>
          </div>
        </Card>
      </div>
    </AppShell>
  )
}
