import { serverOverview, serverScope } from './server-navigation'

export interface WorkspaceTab {
  id: string
  href: string
  title: string
  server: string
  project?: string
  environment?: 'production' | 'staging'
}
export const MAX_WORKSPACE_TABS = 20
export const workspaceKey = (userId: string, role: string) => `synergy:workspace:v1:${userId}:${role}`
const pages = new Set(['/', '/overview', '/projects', '/sites', '/sites/new', '/storage', '/data-services', '/database', '/deployments', '/settings', '/domains', '/services', '/automation', '/infrastructure', '/infrastructure/servers', '/infrastructure/operations', '/infrastructure/health', '/infrastructure/memory', '/infrastructure/disk', '/infrastructure/runtimes'])
const details = /^\/(?:sites|projects|storage|deployments)\/[a-zA-Z0-9_-]{1,128}$/
const remote = /^\/infrastructure\/servers\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i

/** Persist navigation only. Never retain arbitrary query strings, tokens or setup actions. */
export function workspaceHref(value: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\s%]/.test(value.split('?')[0].split('#')[0])) return null
  try {
    const url = new URL(value, 'https://workspace.invalid')
    if (url.origin !== 'https://workspace.invalid' || (!pages.has(url.pathname) && !details.test(url.pathname) && !remote.test(url.pathname))) return null
    const search = new URLSearchParams()
    for (const key of ['tab', 'view', 'section']) {
      const item = url.searchParams.get(key)
      if (item && /^[a-z][a-z0-9-]{0,40}$/.test(item)) search.set(key, item)
    }
    const hash = remote.test(url.pathname) && /^#(?:applications|deployments|server-access|app-[a-f0-9-]{36})$/i.test(url.hash) ? url.hash : ''
    return `${url.pathname}${search.size ? `?${search}` : ''}${hash}`
  } catch { return null }
}

export function workspaceTabId(href: string): string {
  const url = new URL(href, 'https://workspace.invalid')
  return url.pathname + (url.hash.startsWith('#app-') ? url.hash : '')
}

export function workspaceServer(href: string): string {
  const scope = serverScope(new URL(href, 'https://workspace.invalid').pathname)
  return scope.kind === 'remote' ? scope.id : scope.kind
}

export function openWorkspaceTab(tabs: WorkspaceTab[], next: WorkspaceTab): WorkspaceTab[] {
  const found = tabs.findIndex(tab => tab.id === next.id)
  if (found !== -1) return tabs.map((tab, index) => index === found ? next : tab)
  return [...tabs, next].slice(-MAX_WORKSPACE_TABS)
}

export function restoreWorkspace(raw: string | null, allowedServers: string[]): { tabs: WorkspaceTab[]; recent: string[] } {
  try {
    const value = JSON.parse(raw || 'null')
    if (!value || !Array.isArray(value.tabs)) return { tabs: [], recent: [] }
    let tabs: WorkspaceTab[] = []
    for (const candidate of value.tabs.slice(-MAX_WORKSPACE_TABS)) {
      if (!candidate || typeof candidate.href !== 'string' || typeof candidate.title !== 'string') continue
      const href = workspaceHref(candidate.href)
      if (!href) continue
      const server = workspaceServer(href)
      if (!['fleet', 'local', ...allowedServers].includes(server)) continue
      tabs = openWorkspaceTab(tabs, { id: workspaceTabId(href), href, server, title: candidate.title.slice(0, 100),
        ...(typeof candidate.project === 'string' ? { project: candidate.project.slice(0, 100) } : {}),
        ...(['production', 'staging'].includes(candidate.environment) ? { environment: candidate.environment } : {}),
      })
    }
    const recent: string[] = Array.isArray(value.recent) ? (value.recent as unknown[]).filter((id): id is string => typeof id === 'string' && tabs.some(tab => tab.id === id)).slice(-MAX_WORKSPACE_TABS) : []
    return { tabs, recent: [...new Set(recent)] }
  } catch { return { tabs: [], recent: [] } }
}

export function closeWorkspaceTab(tabs: WorkspaceTab[], id: string, activeId: string, recent: string[]) {
  const remaining = tabs.filter(tab => tab.id !== id)
  const active = tabs.find(tab => tab.id === activeId)
  const next = [...recent].reverse().map(key => remaining.find(tab => tab.id === key)).find(tab => tab?.server === active?.server)
    || [...recent].reverse().map(key => remaining.find(tab => tab.id === key)).find(Boolean)
    || remaining.at(-1)
  return { tabs: remaining, href: activeId === id ? next?.href || '/' : null, recent: recent.filter(key => key !== id) }
}

export function resumeServer(tabs: WorkspaceTab[], recent: string[], server: string): string {
  return [...recent].reverse().map(id => tabs.find(tab => tab.id === id)).find(tab => tab?.server === server)?.href || serverOverview(server)
}
