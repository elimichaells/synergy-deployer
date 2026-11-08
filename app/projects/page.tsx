'use client'

import { AppShell } from '@/components/layout/app-shell'
import { AppsView } from '@/components/projects/apps-view'
import { type DeployStatus } from '@/components/synergy/status'
import { Button } from '@/components/ui/button'
import { ProjectCatalog, ProjectsViewSwitch } from '@/components/workspace/project-catalog'
import { isApplicationRoot } from '@/lib/application-environments'
import { Plus, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

interface ProjectApp { id: string; name: string; component_role: string; environment: 'production' | 'staging'; production_id: string | null; project_type: string; setup_required: boolean; deployment_status: DeployStatus | null; deployed_at: string | null; is_active: boolean }
interface Project { id: string; name: string; apps: ProjectApp[]; database_count: number; domains: string[] }

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState('')
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

  const appCount = (projects || []).reduce((sum, project) => sum + project.apps.filter(isApplicationRoot).length, 0)

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
      <ProjectsViewSwitch view={view} onChange={changeView} />
      {view === 'apps' ? <AppsView onSummary={setAppsSummary} /> : <ProjectCatalog projects={projects} projectHref={id => `/projects/${id}`} newHref="/sites/new" now={now} />}
    </AppShell>
  )
}
