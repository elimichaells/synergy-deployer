'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { closeWorkspaceTab, openWorkspaceTab, restoreWorkspace, resumeServer, workspaceKey, type WorkspaceTab } from '@/lib/workspace-navigation'

type State = { key: string; tabs: WorkspaceTab[]; recent: string[]; saved: boolean }
type Workspace = {
  state: State
  register: (userId: string, role: string, servers: string[], tab: WorkspaceTab) => void
  close: (id: string, activeId: string) => string | null
  closeOthers: (activeId: string) => void
  resume: (server: string, userId?: string, role?: string) => string
  clear: () => void
  unsaved: boolean
  setUnsaved: (value: boolean) => void
  navigate: (action: () => void) => void
}
const empty: State = { key: '', tabs: [], recent: [], saved: true }
const Context = createContext<Workspace | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [unsaved, setUnsavedState] = useState(false)
  const dirty = useRef(false)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const setUnsaved = useCallback((value: boolean) => { dirty.current = value; setUnsavedState(value) }, [])
  const navigate = useCallback((action: () => void) => { if (dirty.current) setPending(() => action); else action() }, [])
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = '' } }
    const click = (event: MouseEvent) => {
      if (!dirty.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return
      const destination = new URL(link.href)
      const samePage = destination.pathname === location.pathname && destination.search === location.search
      const remotePage = /^\/infrastructure\/servers\/[^/]+$/.test(location.pathname)
      if (destination.origin !== location.origin || (samePage && (destination.hash === location.hash || destination.hash === '#workspace-content' || !remotePage))) return
      event.preventDefault(); event.stopPropagation()
      navigate(() => router.push(destination.pathname + destination.search + destination.hash))
    }
    window.addEventListener('beforeunload', unload); document.addEventListener('click', click, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true) }
  }, [navigate, router])
  const [state, setState] = useState<State>(empty)
  const current = useRef(state)
  const commit = useCallback((next: State) => {
    try { localStorage.setItem(next.key, JSON.stringify({ tabs: next.tabs, recent: next.recent })); next.saved = true } catch { next.saved = false }
    current.current = next; setState(next)
  }, [])
  const register = useCallback((userId: string, role: string, servers: string[], tab: WorkspaceTab) => {
    const key = workspaceKey(userId, role)
    let previous = current.current
    if (previous.key !== key) {
      let raw: string | null = null
      try { raw = localStorage.getItem(key) } catch { /* Memory-only workspace still works. */ }
      previous = { ...restoreWorkspace(raw, servers), key, saved: true }
    }
    const tabs = openWorkspaceTab(previous.tabs.filter(item => ['local', 'fleet', ...servers].includes(item.server)), tab)
    const recent = [...previous.recent.filter(id => id !== tab.id && tabs.some(item => item.id === id)), tab.id]
    if (JSON.stringify({ tabs, recent }) !== JSON.stringify({ tabs: current.current.tabs, recent: current.current.recent }) || current.current.key !== key) commit({ key, tabs, recent, saved: true })
  }, [commit])
  const close = useCallback((id: string, activeId: string) => {
    const result = closeWorkspaceTab(current.current.tabs, id, activeId, current.current.recent)
    commit({ ...current.current, tabs: result.tabs, recent: result.recent })
    return result.href
  }, [commit])
  const closeOthers = useCallback((activeId: string) => commit({ ...current.current, tabs: current.current.tabs.filter(tab => tab.id === activeId), recent: [activeId] }), [commit])
  const resume = useCallback((server: string, userId?: string, role?: string) => {
    const state = current.current
    return resumeServer(userId && role && state.key === workspaceKey(userId, role) ? state.tabs : [], state.recent, server)
  }, [])
  const clear = useCallback(() => { current.current = empty; setState(empty) }, [])
  return <Context.Provider value={{ state, register, close, closeOthers, resume, clear, unsaved, setUnsaved, navigate }}>{children}
    <AlertDialog.Root open={!!pending} onOpenChange={open => { if (!open) setPending(null) }}><AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[71] w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-6 shadow-2xl">
        <AlertDialog.Title className="text-lg font-semibold">Keep your changes?</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">This page has unsaved changes. Save them before switching pages, or discard them to continue. Sensitive values are never saved in workspace tabs.</AlertDialog.Description>
        <div className="mt-6 flex justify-end gap-2"><AlertDialog.Cancel className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">Keep editing</AlertDialog.Cancel><AlertDialog.Action onClick={() => { const action = pending; setUnsaved(false); setPending(null); action?.() }} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Discard changes</AlertDialog.Action></div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </Context.Provider>
}

export function useWorkspace() {
  const context = useContext(Context)
  if (!context) throw new Error('WorkspaceProvider is required')
  return context
}
