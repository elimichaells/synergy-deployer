'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ManagedServer } from '@/lib/managed-server-types'

export interface ServerDirectory {
  servers: ManagedServer[]
  role: string
  userId: string
  local: { hostname: string; platform: string }
}
const Context = createContext<{ data: ServerDirectory | null; error: string; refresh: () => void }>({ data: null, error: '', refresh: () => {} })

export function ServerDirectoryProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ServerDirectory | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    async function load() {
      if (pending) return
      pending = true
      try {
        const response = await fetch('/api/servers', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load servers')
        if (!controller.signal.aborted) { setData(result); setError('') }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load servers')
      } finally { pending = false }
    }
    void load()
    const timer = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [revision])
  return <Context.Provider value={{ data, error, refresh }}>{children}</Context.Provider>
}

export const useServerDirectory = () => useContext(Context)

export const serverStatusLabel = { online: 'Online', offline: 'Offline', pending: 'Setup needed', revoked: 'Access revoked' }
export const serverStatusColor = { online: 'bg-emerald-400', offline: 'bg-amber-400', pending: 'bg-sky-400', revoked: 'bg-zinc-500' }
