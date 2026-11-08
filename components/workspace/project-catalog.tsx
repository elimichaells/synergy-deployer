'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Boxes, LayoutGrid, List, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { ProjectCard, type ProjectCardData } from './project-card'

export function ProjectsViewSwitch({ view, onChange }: { view: 'projects' | 'apps'; onChange: (view: 'projects' | 'apps') => void }) {
  return <div className="mb-5 flex h-9 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="View">
    {([['projects', 'Projects', LayoutGrid], ['apps', 'Apps', List]] as const).map(([value, label, Icon]) => <button key={value} type="button" onClick={() => onChange(value)} aria-pressed={view === value} className={cn('flex h-full items-center gap-1.5 rounded-[5px] px-3 text-[13px]', view === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}><Icon className="h-3.5 w-3.5" />{label}</button>)}
  </div>
}

/** Both server types render the same catalogue; only destinations and data differ. */
export function ProjectCatalog({ projects, projectHref, newHref, now }: { projects: ProjectCardData[] | null; projectHref: (id: string) => string; newHref?: string; now: number }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const visible = (projects || []).filter(project => [project.name, ...project.apps.map(app => app.name), ...project.domains].some(value => value.toLowerCase().includes(query)))
  return <>
    <div className="mb-6 flex flex-wrap items-center gap-2"><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input aria-label="Search projects" className="control-input pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects, apps or domains…" /></div></div>
    {projects === null ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-52 animate-pulse rounded-[10px] border border-border bg-card" />)}</div>
      : !visible.length ? <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-20 text-center"><span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border"><Boxes className="h-5 w-5 text-muted-foreground" /></span><h2 className="text-base font-medium">{projects.length ? 'No matching projects' : 'Add your first app'}</h2><p className="mt-1 max-w-sm text-sm text-muted-foreground">{projects.length ? 'Try a different search.' : 'Import a repository to create a project and configure its database and domain.'}</p>{!projects.length && newHref && <Button asChild size="sm" className="mt-5"><Link href={newHref}><Plus className="mr-1.5 h-4 w-4" />New app</Link></Button>}</div>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map(project => <ProjectCard key={project.id} project={project} href={projectHref(project.id)} now={now} />)}</div>}
  </>
}
