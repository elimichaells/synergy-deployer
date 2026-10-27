'use client'
import { StatusLabel } from '@/components/synergy/status'
import { ApplicationCard } from '@/components/workspace/application-card'
import { ProjectCard, type ProjectCardData } from '@/components/workspace/project-card'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remoteProcessState } from '@/lib/remote-workspace'
import { LayoutGrid, List, Search } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useState } from 'react'

export function RemoteApplications({ server, apps, jobs, fresh, now }: { now: number; server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; fresh: boolean }) {
  const params = useSearchParams(), root = `/infrastructure/servers/${server.id}`
  const listView = params.get('view') === 'apps'
  const groupId = params.get('view') && !listView ? params.get('view') : null
  const groups: ProjectCardData[] = apps.filter(app => !app.production_id).map(app => {
    const members = apps.filter(item => item.id === app.id || item.production_id === app.id)
    return {id:app.id,name:app.name,domains:members.filter(item => !item.hostname.endsWith('.invalid')).map(item => item.hostname),database_count:members.filter(item => item.database_config).length,
      apps:members.map(item => ({id:item.id,name:item.name,project_type:item.project_type || 'node',environment:item.environment_name || 'production',production_id:item.production_id || null,component_role:'application',setup_required:!!item.guided_setup && !item.setup_completed_at,deployed_at:item.deployed_at,deployment_status:jobs.find(job => job.app_id === item.id)?.status || null}))}
  })
  const group = groups.find(item => item.id === groupId)
  const [search, setSearch] = useState(''), [environment, setEnvironment] = useState('all')
  const filtered = apps.filter(app => (!group || group.apps.some(item => item.id === app.id)) && [app.name, app.repo_url, app.hostname].some(value => value.toLowerCase().includes(search.toLowerCase())) && (environment === 'all' || (environment === 'draft' ? app.guided_setup && !app.setup_completed_at : (app.environment_name || 'production') === environment)))
  return <>
    <div className="mb-5 flex h-9 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="View">{([['projects','Projects',LayoutGrid],['apps','Apps',List]] as const).map(([value,label,Icon]) => <Link key={value} href={`${root}${value === 'apps' ? '?view=apps' : ''}#applications`} aria-current={(listView ? 'apps' : 'projects') === value ? 'page' : undefined} className={`flex h-full items-center gap-1.5 rounded-[5px] px-3 text-[13px] ${(listView ? 'apps' : 'projects') === value ? 'bg-accent' : 'text-muted-foreground'}`}><Icon className="h-3.5 w-3.5" />{label}</Link>)}</div>
    {group && <div className="mb-5"><h2 className="text-lg font-semibold">{group.name}</h2><p className="text-sm text-muted-foreground">Applications and environments on {server.name}</p></div>}
    {!listView && !group ? <><div className="relative mb-6"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input className="control-input pl-9" aria-label="Search projects" placeholder="Search projects, apps or domains…" value={search} onChange={event => setSearch(event.target.value)} /></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{groups.filter(item => [item.name,...item.domains].some(value => value.toLowerCase().includes(search.toLowerCase()))).map(item => <ProjectCard key={item.id} project={item} href={`${root}?view=${item.id}#applications`} now={now} />)}</div>{!groups.length && <p className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">Add your first app to create a project on this server.</p>}</> : <>
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
