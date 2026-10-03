'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { heapLimitFor } from '@/lib/server-memory-policy'
import { cn } from '@/lib/utils'

interface AppMemory {
  running: boolean; usageMb: number; processes: number; peakMb: number; limitMb: number | null; serverTotalMb: number; suggestedMb: number
  alerts: { id: string; level: string; message: string }[]
}

const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`

/** Shows what the app uses and lets an operator cap it, so a leak cannot starve the server. */
export function MemorySetting({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const [memory, setMemory] = useState<AppMemory | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'restart' | 'clear' | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(() => {
    void fetch(`/api/sites/${projectId}/memory`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read memory')
      setMemory(body.memory)
      setDraft(body.memory.limitMb ? String(body.memory.limitMb) : '')
    }).catch(err => setMessage({ tone: 'error', text: (err as Error).message }))
  }, [projectId])
  useEffect(load, [load])

  const save = async (limitMb: number | null, restart: boolean, kind: 'save' | 'restart' | 'clear') => {
    if (restart && !window.confirm('Restart the app now so the new limit applies? It is offline for a few seconds while it restarts.')) return
    setBusy(kind); setMessage(null)
    try {
      const response = await fetch(`/api/sites/${projectId}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limitMb, restart }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not save the limit')
      if (body.restart && !body.restart.healthy) setMessage({ tone: 'error', text: `Saved, but the app did not come back healthy after restarting: ${body.restart.reason}. Open its logs.` })
      else setMessage({ tone: 'ok', text: limitMb === null ? 'Limit removed. It applies the next time the app starts.' : body.restart ? 'Saved. The app restarted with the new limit and is healthy.' : 'Saved. It applies the next time the app is deployed or restarted.' })
      load()
    } catch (err) { setMessage({ tone: 'error', text: (err as Error).message }) } finally { setBusy(null) }
  }

  if (!memory) return message ? <p role="alert" className="notice-error">{message.text}</p> : <div className="h-24 animate-pulse rounded-lg border border-border" />

  const value = Number(draft)
  const valid = draft.trim() !== '' && Number.isInteger(value) && value >= 256 && value <= memory.serverTotalMb
  const changed = (draft.trim() === '' ? null : value) !== memory.limitMb
  const belowPeak = valid && value < memory.peakMb

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border px-4 py-3"><p className="text-xs text-muted-foreground">Using now</p><p className="text-lg font-semibold">{memory.running ? gb(memory.usageMb) : 'Not running'}</p>{memory.running && <p className="text-xs text-muted-foreground">{memory.processes} process{memory.processes === 1 ? '' : 'es'}</p>}</div>
        <div className="rounded-lg border border-border px-4 py-3"><p className="text-xs text-muted-foreground">Peak, last 24 hours</p><p className="text-lg font-semibold">{gb(memory.peakMb)}</p></div>
        <div className="rounded-lg border border-border px-4 py-3"><p className="text-xs text-muted-foreground">Limit</p><p className="text-lg font-semibold">{memory.limitMb ? gb(memory.limitMb) : 'None'}</p>{memory.limitMb && <p className="text-xs text-muted-foreground">Node heap capped at {gb(heapLimitFor(memory.limitMb))}</p>}</div>
      </div>

      {memory.alerts.map(alert => <p key={alert.id} className="flex items-start gap-2 rounded-lg border border-status-building/40 bg-status-building/[0.06] px-3 py-2 text-sm text-amber-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-building" />{alert.message}</p>)}

      <div className="flex flex-wrap items-end gap-3">
        <label className="field-label w-48">Memory limit (MB)
          <input className="control-input font-mono" inputMode="numeric" value={draft} onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))} placeholder="No limit" disabled={!canWrite} aria-describedby="memory-limit-help" />
        </label>
        {canWrite && <Button variant="outline" size="sm" onClick={() => setDraft(String(memory.suggestedMb))}>Use suggested: {gb(memory.suggestedMb)}</Button>}
      </div>
      <p id="memory-limit-help" className="text-xs leading-5 text-muted-foreground">
        Suggested is half again above the last day&apos;s peak. For a Node.js app, its heap is capped at three quarters of the limit, so a leak restarts this app instead of starving the server.
        For every app, Synergy warns when it goes over its limit. The limit applies the next time the app starts.
      </p>
      {draft.trim() !== '' && !valid && <p className="text-xs text-red-300">Enter a whole number from 256 to {memory.serverTotalMb}.</p>}
      {belowPeak && <p className="flex items-start gap-2 text-xs text-amber-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />This is below what the app used in the last day ({gb(memory.peakMb)}). It may run out and restart repeatedly.</p>}

      {canWrite && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!valid || !changed || busy !== null} onClick={() => void save(value, false, 'save')}>{busy === 'save' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Save</Button>
        <Button size="sm" variant="outline" disabled={!valid || busy !== null || !memory.running} onClick={() => void save(value, true, 'restart')}>{busy === 'restart' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Save and restart now</Button>
        {memory.limitMb && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void save(null, false, 'clear')}>Remove limit</Button>}
      </div>}
      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 text-sm', message.tone === 'error' ? 'text-red-300' : 'text-status-ready')}>{message.tone === 'ok' && <Check className="mt-0.5 h-4 w-4 shrink-0" />}{message.text}</p>}
    </div>
  )
}
