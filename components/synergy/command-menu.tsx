'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { CornerDownLeft, Layers, Plus, Search } from 'lucide-react'
import { FrameworkLogo } from './framework-logo'
import { infrastructureItems, navItems } from './nav'

interface Entry { id: string; label: string; hint: string; href: string; icon: React.ReactNode; group: string }
interface ProjectSummary { id: string; name: string; project_type?: string; environment?: string }

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [stacks, setStacks] = useState<{ id: string; name: string; apps: { environment: string }[] }[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    if (projects) return
    void fetch('/api/sites').then(response => response.ok ? response.json() : []).then(data => setProjects(Array.isArray(data) ? data : [])).catch(() => setProjects([]))
    void fetch('/api/groups').then(response => response.ok ? response.json() : { projects: [] }).then(data => setStacks(data.projects || [])).catch(() => setStacks([]))
  }, [open, projects])

  const entries = useMemo<Entry[]>(() => {
    const pages = [...navItems, ...infrastructureItems].map(item => ({ id: `page-${item.href}`, label: item.label, hint: item.description, href: item.href, icon: <item.icon className="h-4 w-4" />, group: 'Navigate' }))
    const actions = [{ id: 'new-app', label: 'New project', hint: 'Import a repository', href: '/sites/new', icon: <Plus className="h-4 w-4" />, group: 'Actions' }]
    const groups = (stacks || []).map(project => ({ id: `project-${project.id}`, label: project.name, hint: `${project.apps.filter(app => app.environment === 'production').length} apps`, href: `/projects/${project.id}`, icon: <Layers className="h-4 w-4" />, group: 'Projects' }))
    const apps = (projects || []).map(project => ({ id: `app-${project.id}`, label: project.name, hint: project.environment || 'application', href: `/sites/${project.id}`, icon: <FrameworkLogo type={project.project_type} className="h-4 w-4" />, group: 'Applications' }))
    const q = query.trim().toLowerCase()
    return [...actions, ...pages, ...groups, ...apps].filter(entry => !q || entry.label.toLowerCase().includes(q) || entry.hint.toLowerCase().includes(q))
  }, [projects, stacks, query])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (entry?: Entry) => {
    if (!entry) return
    onOpenChange(false)
    router.push(entry.href)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(entries.length - 1, index + 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
    if (event.key === 'Enter') { event.preventDefault(); go(entries[active]) }
  }

  let lastGroup = ''
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content onKeyDown={onKeyDown} className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-popover shadow-2xl shadow-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <Dialog.Title className="sr-only">Command menu</Dialog.Title>
          <Dialog.Description className="sr-only">Search pages, applications and actions</Dialog.Description>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search applications, pages and actions…" aria-label="Search" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            <span className="kbd">Esc</span>
          </div>
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
            {entries.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No results for “{query}”.</p>}
            {entries.map((entry, index) => {
              const heading = entry.group !== lastGroup ? entry.group : null
              lastGroup = entry.group
              return (
                <div key={entry.id}>
                  {heading && <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground first:pt-1">{heading}</p>}
                  <button type="button" data-index={index} role="option" aria-selected={index === active} onMouseMove={() => setActive(index)} onClick={() => go(entry)}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${index === active ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground'}`}>
                    <span className="flex h-6 w-6 items-center justify-center text-foreground/80">{entry.icon}</span>
                    <span className="flex-1 truncate text-foreground">{entry.label}</span>
                    <span className={`truncate text-xs text-muted-foreground ${entry.group === 'Applications' ? 'capitalize' : ''}`}>{entry.hint}</span>
                    {index === active && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
            <span className="flex items-center gap-1.5"><span className="kbd">↵</span> open</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
