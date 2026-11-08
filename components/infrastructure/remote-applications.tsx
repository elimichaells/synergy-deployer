'use client'
import { StatusLabel } from '@/components/synergy/status'
import { ApplicationCard } from '@/components/workspace/application-card'
import { ProjectCatalog, ProjectsViewSwitch } from '@/components/workspace/project-catalog'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remoteProcessState, remoteProjects, remoteProjectHref } from '@/lib/remote-workspace'
import { Search } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

export function RemoteApplications({ server, apps, jobs, fresh, now, canCreate }: { now: number; server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; fresh: boolean; canCreate: boolean }) {
  const router = useRouter()
  const params = useSearchParams(), root = `/infrastructure/servers/${server.id}`
  const listView = params.get('view') === 'apps'
  const groups = remoteProjects(server.id, apps, jobs)
  const [search, setSearch] = useState(''), [environment, setEnvironment] = useState('all')
  const filtered = apps.filter(app => [app.name, app.repo_url, app.hostname].some(value => value.toLowerCase().includes(search.toLowerCase())) && (environment === 'all' || (environment === 'draft' ? app.guided_setup && !app.setup_completed_at : (app.environment_name || 'production') === environment)))
  return <>
    <ProjectsViewSwitch view={listView ? 'apps' : 'projects'} onChange={view => router.push(`${root}${view === 'apps' ? '?view=apps' : ''}#applications`)} />
    {!listView ? <ProjectCatalog projects={groups} projectHref={id => remoteProjectHref(server.id, id)} newHref={canCreate ? `${root}#new` : undefined} now={now} /> : <>
    <div className="mb-6 flex flex-wrap items-center gap-2"><div className="relative min-w-[220px] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input className="control-input pl-9" aria-label="Search applications" placeholder="Search applications or repositories…" value={search} onChange={event => setSearch(event.target.value)} /></div><select className="control-input w-auto" aria-label="Environment" value={environment} onChange={event => setEnvironment(event.target.value)}><option value="all">All environments</option><option value="production">Production</option><option value="staging">Staging</option><option value="draft">Setup incomplete</option></select></div>
    {!filtered.length ? <div className="rounded-xl border border-dashed border-border px-6 py-16 text-center"><h2 className="font-medium">{apps.length ? 'No matching applications' : 'Deploy your first application'}</h2><p className="mt-1 text-sm text-muted-foreground">{apps.length ? 'Try a different search or environment.' : 'Import a Git repository to get started.'}</p></div> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{filtered.map(app => {
      const job = jobs.find(item => item.app_id === app.id), latest = job ? remoteDeployment(job, apps) : undefined
      const status = remoteProcessState(server, app, fresh), setup = !!app.guided_setup && !app.setup_completed_at
      return <ApplicationCard key={app.id} project={{...app,project_type:app.project_type || 'node',url:app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`,environment:app.environment_name || 'production',is_active:status.readiness === 'ready'}} latest={latest} href={remoteAppHref(server.id, app.id, setup ? 'setup' : undefined)} statusLabel={status.label}
        deploymentLine={setup ? <span className="text-status-building">Setup incomplete — continue configuration</span> : latest ? <StatusLabel status={latest.status} /> : 'No deployments yet'} />
    })}</div>}
  </>}
  </>
}
