'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export function ApplicationHealth({ id, canWrite }: { id: string; canWrite: boolean }) {
  const [path, setPath] = useState('/')
  const [statuses, setStatuses] = useState('')
  const [timeout, setTimeoutSeconds] = useState(60)
  const [state, setState] = useState('Checking…')
  const [checked, setChecked] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let stopped = false
    void fetch('/api/sites/' + id + '/health', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error('Health settings could not be loaded')
      const data = await r.json()
      if (stopped) return
      setPath(data.profile.path); setStatuses(data.profile.statuses.join(', ')); setTimeoutSeconds(data.profile.timeoutMs / 1000)
      setState(data.stale ? 'Unknown — monitoring is stale' : data.application?.health || 'Unknown — no observation yet')
      setChecked(data.checkedAt); setLoaded(true)
    }).catch(error => { if (!stopped) { setState('Unknown'); setMessage(error.message) } })
    return () => { stopped = true }
  }, [id])
  async function save() {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/sites/' + id + '/health', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, statuses: statuses.trim() ? statuses.split(',').map(x => Number(x.trim())) : [], timeoutMs: timeout * 1000 }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save health settings')
      setMessage('Saved. The next monitor check and deployment will use these settings. The app was not restarted.')
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-border bg-card p-5">
    <h2 className="text-sm font-semibold">Application readiness <span className="ml-2 font-normal capitalize text-muted-foreground">{state}</span></h2>
    <p className="mt-2 text-xs text-muted-foreground">Verify a local page or readiness endpoint. Local redirects are followed; failed pages and external redirects do not pass. {checked && 'Last checked ' + new Date(checked).toLocaleString() + '.'}</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      <label className="text-xs">Readiness path<input className="mt-1 w-full rounded border border-border bg-background p-2" value={path} disabled={!canWrite || !loaded} onChange={e => setPath(e.target.value)} placeholder="/api/health" /></label>
      <label className="text-xs">Expected HTTP codes<input className="mt-1 w-full rounded border border-border bg-background p-2" value={statuses} disabled={!canWrite || !loaded} onChange={e => setStatuses(e.target.value)} placeholder="Any 2xx (default)" /></label>
      <label className="text-xs">Startup timeout (seconds)<input type="number" min={5} max={180} className="mt-1 w-full rounded border border-border bg-background p-2" value={timeout} disabled={!canWrite || !loaded} onChange={e => setTimeoutSeconds(Number(e.target.value))} /></label>
    </div>
    {canWrite && <Button className="mt-3" size="sm" variant="outline" disabled={busy || !loaded} onClick={() => void save()}>{busy ? 'Saving…' : 'Save readiness settings'}</Button>}
    {message && <p role="status" className="mt-3 text-xs">{message}</p>}
  </section>
}
