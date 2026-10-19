'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import type { ServerHealth } from '@/lib/server-health-types'

const initial = { health: null as ServerHealth | null, error: false }
let snapshot = initial
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let inFlight = false
async function refresh() {
  if (inFlight) return
  inFlight = true
  try {
    const response = await fetch('/api/server/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error('Health unavailable')
    snapshot = { health: await response.json(), error: false }
  } catch { snapshot = { ...snapshot, error: true } }
  finally { inFlight = false; listeners.forEach(listener => listener()) }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer) { void refresh(); timer = setInterval(() => void refresh(), 30_000) }
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined } }
}
export function useServerHealth() { return useSyncExternalStore(subscribe, () => snapshot, () => initial) }

export function ServerHealthBanner() {
  const { health, error } = useServerHealth()
  if (!health && !error) return null
  const active = health?.incidents.filter(x => !x.resolvedAt) || []
  const unavailable = error || health?.stale
  if (!active.length && !unavailable) return null
  const critical = active.some(x => x.severity === 'critical')
  return <div role="alert" className={`mb-5 flex items-start gap-3 rounded-lg border p-4 text-sm ${critical ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
    <div className="min-w-0 flex-1">
      <p className="font-medium">{unavailable ? 'Server monitoring needs attention' : `${active.length} active alert${active.length === 1 ? '' : 's'}`}</p>
      <p className="mt-1 text-muted-foreground">{unavailable ? 'Fresh checks are unavailable. Open Server health to inspect the last recorded state.' : active.find(x => x.severity === 'critical')?.message || active[0]?.message}</p>
    </div>
    <Link href="/infrastructure/health" className="inline-flex shrink-0 items-center gap-1 text-xs underline underline-offset-4">View alerts<ArrowRight className="h-3 w-3" /></Link>
  </div>
}
