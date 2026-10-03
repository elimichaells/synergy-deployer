'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, Check, Loader2, Truck, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface Plan {
  database: string; sizeBytes: number; targetDatabase: string; roleName: string
  source: { name: string; port: number; version: string | null }; target: { name: string; port: number; version: string | null } | null
  extensions: { name: string; schema: string }[]
  apps: { projectId: string; name: string; environment: string; running: boolean; files: { file: string; changes: number }[] }[]
  connections: { login: string; application: string; count: number }[]
  minutes: { low: number; high: number }; blockers: string[]; notes: string[]
}
interface Move { id: string; status: string; log: string; error: string | null; copy_path: string | null; started_at: string; finished_at: string | null }

const mb = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`
const statusText: Record<string, string> = { running: 'Moving…', succeeded: 'Moved', rolled_back: 'Stopped; nothing changed for the apps', failed: 'Failed', interrupted: 'Interrupted' }

function MoveLog({ move }: { move: Move }) {
  const tone = move.status === 'succeeded' ? 'text-status-ready' : move.status === 'running' ? 'text-syn-cyan' : 'text-red-300'
  return (
    <div className="space-y-2">
      <p className={cn('flex items-center gap-2 text-sm font-medium', tone)}>
        {move.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : move.status === 'succeeded' ? <Check className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {statusText[move.status] || move.status}
      </p>
      {move.error && <p className="text-xs text-red-300">{move.error}</p>}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-black p-3 font-mono text-[11px] leading-5 text-white/80">{move.log || 'Starting…'}</pre>
    </div>
  )
}

/** Moves a PostgreSQL database to another server, with the plan shown and confirmed first. */
export function MoveDatabaseSheet({ serviceId, open, onOpenChange, onDone }: { serviceId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [move, setMove] = useState<Move | null>(null)
  const [canMove, setCanMove] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const timer = useRef<number | null>(null)

  const follow = useCallback((id: string) => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = window.setInterval(() => {
      void fetch(`/api/storage/moves/${id}`, { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(body => {
        if (!body?.move) return
        setMove(body.move)
        if (body.move.status !== 'running') { if (timer.current) window.clearInterval(timer.current); timer.current = null; onDone() }
      }).catch(() => {})
    }, 2000)
  }, [onDone])

  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current) }, [])
  useEffect(() => {
    if (!open) return
    setPlan(null); setError(''); setConfirm('')
    void fetch(`/api/storage/${serviceId}/move`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not work out the move')
      setPlan(body.plan); setCanMove(!!body.canMove); setMove(body.latest)
      if (body.latest?.status === 'running') follow(body.latest.id)
    }).catch(err => setError((err as Error).message))
  }, [open, serviceId, follow])

  const start = async () => {
    setStarting(true); setError('')
    try {
      const response = await fetch(`/api/storage/${serviceId}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The move could not start')
      setMove({ id: body.move.id, status: 'running', log: '', error: null, copy_path: null, started_at: new Date().toISOString(), finished_at: null })
      follow(body.move.id)
    } catch (err) { setError((err as Error).message) } finally { setStarting(false) }
  }

  const running = move?.status === 'running'
  return (
    <Sheet open={open} onOpenChange={next => { if (!starting) onOpenChange(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Move to another server</SheetTitle>
          <SheetDescription>Copies this database exactly to another PostgreSQL server on this machine, gives it its own login, and switches its apps over.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          {!plan && !error && <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Working out the move…</div>}
          {error && <p role="alert" className="notice-error">{error}</p>}

          {move && <MoveLog move={move} />}

          {plan && !running && move?.status !== 'succeeded' && <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4 text-sm">
              <div className="min-w-0"><p className="text-xs text-muted-foreground">From</p><p className="font-medium">{plan.source.name}</p><p className="font-mono text-xs text-muted-foreground">{plan.database} · port {plan.source.port}</p></div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0"><p className="text-xs text-muted-foreground">To</p><p className="font-medium">{plan.target?.name ?? '—'}</p><p className="font-mono text-xs text-muted-foreground">{plan.targetDatabase} · port {plan.target?.port ?? '—'} · login {plan.roleName || '—'}</p></div>
            </div>

            {plan.blockers.length > 0 && <ul className="space-y-2">{plan.blockers.map(blocker => <li key={blocker} className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-300"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{blocker}</li>)}</ul>}

            <div>
              <p className="mb-2 text-sm font-medium">What happens</p>
              <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-muted-foreground">
                <li>An empty {plan.targetDatabase} is created on {plan.target?.name ?? 'the target'}, owned by a new login that can only reach it{plan.extensions.length ? `, with ${plan.extensions.map(item => item.name).join(', ')}` : ''}.</li>
                <li>{plan.apps.filter(app => app.running).map(app => app.name).join(', ') || 'Its apps'} {plan.apps.filter(app => app.running).length === 1 ? 'is' : 'are'} stopped, with any workers, so nothing writes during the copy. Scheduled jobs wait.</li>
                <li>An exact copy is made ({mb(plan.sizeBytes)}) and checked: every table&apos;s row count, every sequence, every view, function and index must match.</li>
                <li>The apps&apos; env files are pointed at the copy (originals are saved), and the apps are started and health-checked.</li>
                <li>If anything fails, the apps go back to the original, which is never changed, and the unfinished copy is removed.</li>
              </ol>
            </div>

            <div className="rounded-lg border border-border p-4 text-sm">
              <p className="font-medium">Downtime: about {plan.minutes.low} to {plan.minutes.high} minutes</p>
              <ul className="mt-2 space-y-1">{plan.apps.map(app => (
                <li key={app.projectId} className="text-xs text-muted-foreground">{app.name} <span className="capitalize">({app.environment})</span>{app.running ? '' : ', not running now'} · {app.files.map(file => file.file).join(', ') || 'no settings found'}</li>
              ))}</ul>
            </div>

            {plan.notes.length > 0 && <ul className="space-y-1.5">{plan.notes.map(note => <li key={note} className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-building" />{note}</li>)}</ul>}

            {canMove && plan.blockers.length === 0 && <div className="space-y-3 rounded-lg border border-status-building/30 bg-status-building/[0.04] p-4">
              <label className="field-label">Type <span className="font-mono">{plan.database}</span> to confirm
                <input className="control-input font-mono" value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <Button className="w-full" disabled={confirm !== plan.database || starting} onClick={() => void start()}>
                {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}Stop the apps and move {plan.database} now
              </Button>
            </div>}
            {!canMove && <p className="text-xs text-muted-foreground">Only an administrator can move a database.</p>}
          </>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
