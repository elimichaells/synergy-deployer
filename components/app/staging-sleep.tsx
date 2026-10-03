'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Moon, Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SLEEP_CHOICES, sleepLabel } from '@/lib/staging-sleep-policy'
import { cn } from '@/lib/utils'

export interface SleepState { environment?: string | null; sleep_after_minutes: number | null; sleeping_since: string | null; last_active_at: string | null }

const ago = (iso: string | null) => {
  if (!iso) return 'not yet'
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`
}

/** Sets how long a staging app may sit idle before it sleeps. */
export function SleepSelect({ projectId, minutes, disabled, onChanged, className }: { projectId: string; minutes: number | null; disabled?: boolean; onChanged: (minutes: number | null, warning: string | null) => void; className?: string }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const change = async (value: string) => {
    setSaving(true); setError('')
    try {
      const response = await fetch(`/api/sites/${projectId}/sleep`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minutes: value ? Number(value) : null }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save')
      onChanged(body.minutes ?? null, body.caddyWarning ?? null)
    } catch (err) { setError((err as Error).message) } finally { setSaving(false) }
  }
  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      <span className="inline-flex items-center gap-2">
        <select aria-label="Sleep when idle" className="control-input h-8 w-auto py-0 text-[13px]" value={minutes ?? ''} disabled={disabled || saving} onChange={event => void change(event.target.value)}>
          <option value="">Never sleep</option>
          {SLEEP_CHOICES.map(choice => <option key={choice} value={choice}>{sleepLabel(choice)}</option>)}
        </select>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </span>
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </span>
  )
}

export function WakeButton({ projectId, disabled, onWoken }: { projectId: string; disabled?: boolean; onWoken?: () => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'error'>('idle')
  const wake = async () => {
    setState('starting')
    const response = await fetch(`/api/sites/${projectId}/wake`, { method: 'POST' }).catch(() => null)
    if (!response?.ok) { setState('error'); return }
    // Starting takes about as long as a restart; check back after a short while.
    window.setTimeout(() => { setState('idle'); onWoken?.() }, 20_000)
  }
  return (
    <Button size="sm" variant="outline" disabled={disabled || state === 'starting'} onClick={() => void wake()}>
      {state === 'starting' ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Starting…</> : <><Power className="mr-1.5 h-3.5 w-3.5" />{state === 'error' ? 'Try again' : 'Wake now'}</>}
    </Button>
  )
}

function useSleepState(projectId: string) {
  const [sleep, setSleep] = useState<SleepState | null>(null)
  const load = useCallback(() => {
    void fetch(`/api/sites/${projectId}/sleep`, { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(body => { if (body) setSleep(body.sleep) }).catch(() => {})
  }, [projectId])
  useEffect(load, [load])
  return { sleep, load, setSleep }
}

/** Settings control for a staging app. */
export function StagingSleepSetting({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const { sleep, load } = useSleepState(projectId)
  const [warning, setWarning] = useState<string | null>(null)
  if (!sleep) return <div className="h-16 animate-pulse rounded-lg border border-border" />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-sm">
        <span className="flex min-w-0 items-start gap-3">
          <Moon className={cn('mt-0.5 h-4 w-4 shrink-0', sleep.sleeping_since ? 'text-syn-violet' : 'text-muted-foreground')} />
          <span>
            <span className="block font-medium">{sleep.sleeping_since ? `Asleep since ${new Date(sleep.sleeping_since).toLocaleString()}` : sleep.sleep_after_minutes ? 'Awake' : 'Always running'}</span>
            <span className="block text-xs text-muted-foreground">{sleep.sleep_after_minutes ? `Last used ${ago(sleep.last_active_at)}. ` : ''}A sleeping app wakes when it is deployed, when you press Wake now, or when someone opens it; they see a short &quot;starting up&quot; page.</span>
          </span>
        </span>
        <span className="flex items-center gap-2">
          {sleep.sleeping_since && canWrite && <WakeButton projectId={projectId} onWoken={load} />}
          <SleepSelect projectId={projectId} minutes={sleep.sleep_after_minutes} disabled={!canWrite} onChanged={(_, caddyWarning) => { setWarning(caddyWarning); load() }} />
        </span>
      </div>
      {warning && <p role="alert" className="text-xs text-amber-200">{warning}</p>}
    </div>
  )
}

/** A notice at the top of a sleeping staging app's page. */
export function StagingAsleepBanner({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const { sleep, load } = useSleepState(projectId)
  if (!sleep?.sleeping_since) return null
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-syn-violet/40 bg-syn-violet/[0.06] px-4 py-3 text-sm">
      <Moon className="h-4 w-4 shrink-0 text-syn-violet" />
      <p className="min-w-0 flex-1">This staging app is asleep to save memory. It wakes when it is deployed or when someone opens it.</p>
      {canWrite && <WakeButton projectId={projectId} onWoken={load} />}
    </div>
  )
}
