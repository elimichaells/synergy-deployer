'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import { CornerDownLeft, Layers, Plus, Search, Server } from 'lucide-react'
import { FrameworkLogo } from './framework-logo'
import { infrastructureItems, workspaceNavItems } from './nav'
import { isApplicationRoot } from '@/lib/application-environments'
import { serverOverview, serverScope } from '@/lib/server-navigation'
import { useServerDirectory } from '@/components/infrastructure/server-directory'
import { useWorkspace } from '@/components/layout/workspace-provider'

interface Entry { id: string; label: string; hint: string; href: string; icon: React.ReactNode; group: string }
interface ProjectSummary { id: string; name: string; project_type?: string; environment?: string }

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const { navigate, resume, state: workspace } = useWorkspace()
  const pathname = usePathname()
  const scope = serverScope(pathname)
  const remoteId = scope.kind === 'remote' ? scope.id : null
  const { data: directory } = useServerDirectory()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [stacks, setStacks] = useState<{ id: string; name: string; apps: { environment: string; production_id: string | null }[] }[] | null>(null)
  const [remoteApps, setRemoteApps] = useState<{ id: string; name: string; hostname: string }[]>([])
  const [loadedScope, setLoadedScope] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setProjects(null); setStacks(null); setRemoteApps([]); setLoadedScope('')
    const controller = new AbortController()
    async function load() {
      try {
        if (remoteId) {
          const response = await fetch(`/api/servers/${remoteId}`, { cache: 'no-store', signal: controller.signal })
          if (!response.ok) return
          const result = await response.json()
          if (!controller.signal.aborted) { setRemoteApps(result.apps || []); setLoadedScope(remoteId) }
        } else if (scope.kind === 'local') {
          const [apps, groups] = await Promise.all(['/api/sites', '/api/groups'].map(url => fetch(url, { cache: 'no-store', signal: controller.signal }).then(response => response.ok ? response.json() : null)))
          if (!controller.signal.aborted) { setProjects(Array.isArray(apps) ? apps : []); setStacks(groups?.projects || []); setLoadedScope('local') }
        }
      } catch { /* Navigation and server switching remain available. */ }
    }
    void load()
    return () => controller.abort()
  }, [open, remoteId, scope.kind])

  const entries = useMemo<Entry[]>(() => {
    const pages = [...workspaceNavItems(pathname), ...(scope.kind === 'local' ? infrastructureItems : [])].map(item => ({ id: `page-${item.href}`, label: item.label, hint: item.description, href: item.href, icon: <item.icon className="h-4 w-4" />, group: 'Navigate' }))
    const actions = directory?.role === 'admin' ? [{ id: 'add-server', label: 'Add server', hint: 'Connect Windows or Linux', href: '/infrastructure/servers?add=1', icon: <Plus className="h-4 w-4" />, group: 'Actions' }, ...(scope.kind === 'local' ? [{ id: 'new-app', label: 'New app', hint: 'Import a repository on Manager host', href: '/sites/new', icon: <Plus className="h-4 w-4" />, group: 'Actions' }] : [])] : []
    const groups = (scope.kind === 'local' && loadedScope === 'local' ? stacks || [] : []).map(project => ({ id: `project-${project.id}`, label: project.name, hint: `${project.apps.filter(isApplicationRoot).length} apps`, href: `/projects/${project.id}`, icon: <Layers className="h-4 w-4" />, group: 'Projects' }))
    const apps = remoteId && loadedScope === remoteId ? remoteApps.map(app => ({ id: `app-${app.id}`, label: app.name, hint: app.hostname, href: `${serverOverview(remoteId)}#app-${app.id}`, icon: <Layers className="h-4 w-4" />, group: 'Applications' })) : (scope.kind === 'local' && loadedScope === 'local' ? projects || [] : []).map(project => ({ id: `app-${project.id}`, label: project.name, hint: project.environment || 'application', href: `/sites/${project.id}`, icon: <FrameworkLogo type={project.project_type} className="h-4 w-4" />, group: 'Applications' }))
    const destination = (id: string) => workspace.key ? resume(id, directory?.userId, directory?.role) : serverOverview(id)
    const servers = [{ id: 'server-local', label: 'Manager host', hint: 'Local server', href: destination('local'), icon: <Server className="h-4 w-4" />, group: 'Switch server' }, ...(directory?.servers || []).filter(server => server.enabled).map(server => ({ id: `server-${server.id}`, label: server.name, hint: server.location || (server.platform === 'win32' ? 'Windows' : 'Linux'), href: server.status === 'revoked' ? serverOverview(server.id) : destination(server.id), icon: <Server className="h-4 w-4" />, group: 'Switch server' }))]
    const q = query.trim().toLowerCase()
    return [...actions, ...pages, ...servers, ...groups, ...apps].filter(entry => !q || entry.label.toLowerCase().includes(q) || entry.hint.toLowerCase().includes(q))
  }, [projects, stacks, query, directory, pathname, scope.kind, remoteId, remoteApps, loadedScope, resume, workspace])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, entries.length - 1))) }, [entries.length])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const go = (entry?: Entry) => {
    if (!entry) return
    onOpenChange(false)
    navigate(() => router.push(entry.href))
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
          <Dialog.Description className="sr-only">Search this workspace or switch servers</Dialog.Description>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search this workspace or switch servers…" aria-label="Search" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
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
