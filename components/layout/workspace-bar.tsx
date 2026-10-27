'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Boxes, Check, ChevronDown, ChevronRight, Circle, Cloud, LayoutGrid, Plus, Server, X } from 'lucide-react'
import { useServerDirectory } from '@/components/infrastructure/server-directory'
import { serverOverview } from '@/lib/server-navigation'
import { workspaceHref, workspaceKey, workspaceServer, workspaceTabId, type WorkspaceTab } from '@/lib/workspace-navigation'
import { useWorkspace } from './workspace-provider'

export type WorkspaceContextInfo = { project?: { name: string; href: string }; environment?: 'production' | 'staging'; page?: string; destinations?: Record<string, string> }
const sectionNames: Record<string, string> = { overview: 'Overview', env: 'Environment', environment: 'Environment', setup: 'Setup', settings: 'Settings', logs: 'Logs', console: 'Console', deployments: 'Deployments', domains: 'Domains', storage: 'Storage', stack: 'Stack', health: 'Health', apps: 'Applications', databases: 'Databases', team: 'Team', general: 'General', updates: 'Updates', applications: 'Applications', 'server-access': 'Server access' }
const pageNames: Record<string, string> = { '/': 'Servers', '/overview': 'Overview', '/projects': 'Projects', '/sites': 'Applications', '/sites/new': 'New application', '/settings': 'Settings', '/storage': 'Storage', '/deployments': 'Deployments', '/infrastructure': 'Infrastructure', '/infrastructure/servers': 'Server connections' }

export function WorkspaceBar({ title, context, onNew, onHashChange }: { title: string; context?: WorkspaceContextInfo; onNew: () => void; onHashChange: (hash: string) => void }) {
  const pathname = usePathname(), params = useSearchParams(), router = useRouter()
  const { data, error } = useServerDirectory()
  const { state, register, close, closeOthers, unsaved, navigate } = useWorkspace()
  const [hash, setHash] = useState('')
  const strip = useRef<HTMLDivElement>(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const sync = () => setHash(window.location.hash)
    const click = () => { timer = setTimeout(sync, 0) }
    sync(); window.addEventListener('hashchange', sync); window.addEventListener('popstate', sync); document.addEventListener('click', click)
    return () => { clearTimeout(timer); window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); document.removeEventListener('click', click) }
  }, [pathname, params])
  useEffect(() => { onHashChange(hash) }, [hash, onHashChange])
  const href = workspaceHref(`${pathname}${params.size ? `?${params}` : ''}${hash}`)
  const activeId = href ? workspaceTabId(href) : ''
  const serverId = href ? workspaceServer(href) : 'fleet'
  const server = data?.servers.find(item => item.id === serverId)
  const serverLabel = (id: string) => id === 'fleet' ? 'All servers' : id === 'local' ? 'Manager host' : data?.servers.find(item => item.id === id)?.name || 'Server unavailable'
  const serverTitle = serverLabel(serverId)
  const allowedServers = data?.servers.filter(item => item.enabled && item.status !== 'revoked').map(item => item.id).sort().join(',') || ''
  const key = data ? workspaceKey(data.userId, data.role) : ''
  const userId = data?.userId, role = data?.role
  const tabs = state.key === key ? state.tabs : []
  const section = params.get('tab') || params.get('section') || hash.slice(1)
  const sectionTitle = sectionNames[section] || (section ? section.replaceAll('-', ' ').replace(/^./, c => c.toUpperCase()) : '')
  const detail = /^\/(sites|projects|storage|deployments)\/[^/]+$/.test(pathname) && !pathname.endsWith('/new')
  const isRemote = !['fleet', 'local'].includes(serverId)
  const label = hash.startsWith('#app-') ? context?.destinations?.[hash] || 'Application' : isRemote ? sectionTitle || 'Overview' : context?.page || pageNames[pathname] || title
  useEffect(() => {
    if (!userId || !role || !href || error || /^(Loading|Opening)\b/.test(title) || /not found|unavailable/i.test(title)) return
    register(userId, role, allowedServers.split(',').filter(Boolean), { id: activeId, href, title: label, server: serverId, project: context?.project?.name, environment: context?.environment })
  }, [userId, role, href, activeId, title, label, serverId, allowedServers, error, context?.project?.name, context?.environment, register])
  useEffect(() => {
    const container = strip.current, active = container?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement
    if (!container || !active) return
    const bounds = container.getBoundingClientRect(), target = active.getBoundingClientRect()
    if (target.left < bounds.left) container.scrollLeft -= bounds.left - target.left
    else if (target.right > bounds.right) container.scrollLeft += target.right - bounds.right
  }, [activeId, tabs.length])
  useEffect(() => { if (announcement) strip.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true }) }, [announcement, activeId])

  function remove(tab: WorkspaceTab) {
    const action = () => { const destination = close(tab.id, activeId); setAnnouncement(`Closed ${tab.title}`); if (destination) router.push(destination) }
    if (tab.id === activeId) navigate(action); else action()
  }
  function onKey(event: KeyboardEvent, index: number) {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else if (event.key === 'Delete' && tabs[index].id !== '/') { event.preventDefault(); remove(tabs[index]); return }
    else return
    event.preventDefault()
    strip.current?.querySelectorAll<HTMLAnchorElement>('[data-workspace-link]')[next]?.focus()
  }

  return <div className="workspace-chrome">
    <div className="workspace-strip mx-auto flex max-w-[1240px] items-end px-2 sm:px-4">
      <div ref={strip} aria-label="Open workspace pages" className="scrollbar-none flex min-w-0 flex-1 gap-0.5 overflow-x-auto pt-1" role="navigation">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const Icon = tab.server === 'fleet' ? LayoutGrid : /^\/(sites|projects)\//.test(tab.id) || tab.id.includes('#app-') ? Boxes : Server
          return <div key={tab.id} className={`workspace-page-tab group ${active ? 'is-active' : ''}`}>
            <Link data-workspace-link href={tab.href} aria-current={active ? 'page' : undefined} aria-label={`${tab.title} · ${serverLabel(tab.server)}${tab.environment ? ` · ${tab.environment}` : ''}`} onKeyDown={event => onKey(event, index)} className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1" title={`${serverLabel(tab.server)}${tab.project ? ` / ${tab.project}` : ''} / ${tab.title}${tab.environment ? ` / ${tab.environment}` : ''}`}>
              <span className={`workspace-tab-icon ${tab.server === 'fleet' ? 'is-fleet' : tab.server === 'local' ? 'is-local' : 'is-remote'}`}><Icon className="h-3 w-3" /></span>
              <span className="truncate text-[11px] font-medium">{tab.title === 'Overview' && !['fleet', 'local'].includes(tab.server) ? serverLabel(tab.server) : tab.title}</span>
              {tab.environment && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.environment === 'production' ? 'bg-status-ready' : 'bg-status-building'}`} title={tab.environment} />}
              {active && unsaved && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-building" title="Unsaved changes" aria-label="Unsaved changes" />}
            </Link>
            {tab.id !== '/' && <button type="button" aria-label={`Close ${tab.title}`} title={`Close ${tab.title} · ${serverLabel(tab.server)}`} onClick={() => remove(tab)} className="mr-0.5 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-3 w-3" /></button>}
          </div>
        })}
        {!tabs.length && <span className="px-2 py-2 text-[11px] text-muted-foreground">Your workspace</span>}
      </div>
      <button type="button" aria-label="Open another workspace page" title="Open another page · Ctrl K" onClick={onNew} className="mx-0.5 mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-primary"><Plus className="h-3.5 w-3.5" /></button>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" aria-label="List open workspace pages" className="mb-0.5 flex h-7 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent"><span>{tabs.length}</span><ChevronDown className="h-3 w-3" /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={8} className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover p-1.5 shadow-xl">
          <DropdownMenu.Label className="px-2 py-2 text-xs text-muted-foreground">Open pages · {tabs.length} of 20</DropdownMenu.Label>
          <div className="max-h-72 overflow-y-auto">{tabs.map(tab => <DropdownMenu.Item key={tab.id} asChild><Link href={tab.href} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent"><span className="min-w-0 flex-1"><span className="block truncate">{tab.title}</span><span className="block truncate text-xs text-muted-foreground">{serverLabel(tab.server)}{tab.project && ` · ${tab.project}`}</span></span>{tab.id === activeId && <Check className="h-4 w-4 text-primary" />}</Link></DropdownMenu.Item>)}</div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" /><DropdownMenu.Item disabled={tabs.length < 2} onSelect={() => closeOthers(activeId)} className="cursor-pointer rounded-md px-2 py-2 text-xs outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent">Close other pages</DropdownMenu.Item>
          <p className="border-t border-border px-2 pt-2 text-[11px] leading-5 text-muted-foreground">{state.saved ? 'Open pages are remembered for your account in this browser.' : 'Browser storage is unavailable. Pages stay open for this visit.'} Unsaved form values are not stored.</p>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
    <div className="workspace-context">
      <div className="mx-auto flex min-h-8 max-w-[1240px] items-center gap-3 px-4 py-1.5 sm:px-6">
        <nav aria-label="Workspace location" className="min-w-0 flex-1"><ol className="flex items-center gap-1.5 overflow-hidden text-[11px] sm:gap-2 sm:text-xs">
          <li className="shrink-0"><Link href="/" className="text-muted-foreground hover:text-primary" aria-label="All servers"><LayoutGrid className="h-3.5 w-3.5" /></Link></li>
          <li aria-hidden="true" className="shrink-0"><ChevronRight className="h-3 w-3 text-muted-foreground/60" /></li>
          <li className="max-w-40 shrink-0 truncate"><Link href={serverId === 'fleet' ? '/' : serverOverview(serverId)} className="font-medium text-primary">{serverTitle}</Link></li>
          {context?.project && <><li aria-hidden="true" className="hidden shrink-0 sm:block"><ChevronRight className="h-3 w-3 text-muted-foreground/60" /></li><li className="hidden min-w-0 truncate sm:block"><Link href={context.project.href} className="text-muted-foreground hover:text-primary">{context.project.name}</Link></li></>}
          <li aria-hidden="true" className="shrink-0"><ChevronRight className="h-3 w-3 text-muted-foreground/60" /></li><li className="min-w-0 truncate font-medium" aria-current={isRemote || !sectionTitle ? 'page' : undefined}>{label}</li>
          {sectionTitle && !isRemote && <><li aria-hidden="true" className="shrink-0"><ChevronRight className="h-3 w-3 text-muted-foreground/60" /></li><li className="shrink-0 text-muted-foreground" aria-current="page">{sectionTitle}</li></>}
          {detail && context?.environment && <li className={`environment-chip ml-1 hidden sm:inline-flex ${context.environment}`}>{context.environment}</li>}
        </ol></nav>
        <span className="hidden shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground lg:flex" title={state.saved ? 'Navigation is saved in this browser for your account. Form contents are not saved.' : 'Browser storage is unavailable'}>{server && <><Circle className={`h-1.5 w-1.5 fill-current ${!error && server.status === 'online' ? 'text-status-ready' : 'text-status-building'}`} />{error ? 'Status unavailable' : server.status}<span className="mx-1 text-border">|</span></>}<Cloud className="h-3 w-3" />{state.saved ? 'Workspace remembered' : 'This visit only'}</span>
      </div>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>
}
