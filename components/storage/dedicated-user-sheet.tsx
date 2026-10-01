'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, FileCog, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface Plan {
  database: string; serverName: string; currentUser: string | null; roleName: string; objectCount: number; objectKinds: Record<string, number>
  apps: { serviceId: string; name: string; environment: string; files: { file: string; changes: number }[] }[]
  blockers: string[]; notes: string[]
}

/**
 * Walks an admin through switching a database from a superuser login to its own
 * limited user: shows exactly what changes, then runs it and reports each step.
 */
export function DedicatedUserSheet({ serviceId, open, onOpenChange, onDone }: { serviceId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; steps?: string[]; message?: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setPlan(null); setResult(null); setUnderstood(false); setLoading(true)
    void fetch(`/api/storage/${serviceId}/dedicated-user`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not prepare the switch')
      setPlan(body.plan)
    }).catch(error => setResult({ ok: false, message: error.message })).finally(() => setLoading(false))
  }, [open, serviceId])

  const run = async () => {
    setRunning(true); setResult(null)
    try {
      const response = await fetch(`/api/storage/${serviceId}/dedicated-user`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The switch failed')
      setResult({ ok: true, steps: body.steps })
      onDone()
    } catch (error) { setResult({ ok: false, message: (error as Error).message }) } finally { setRunning(false) }
  }

  return (
    <Sheet open={open} onOpenChange={next => { if (!running) onOpenChange(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Give this database its own user</SheetTitle>
          <SheetDescription>Replace the superuser login with a user that can only reach {plan?.database || 'this database'}.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          {loading && <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking the database and its apps…</div>}

          {plan && !result?.ok && (
            <>
              <ol className="space-y-3 text-sm">
                {[
                  <>Create the user <span className="font-mono text-foreground">{plan.roleName}</span> on {plan.serverName}. It is not a superuser and can&apos;t create other users or databases.</>,
                  <>Make it the owner of <span className="font-mono text-foreground">{plan.database}</span> and its {plan.objectCount} objects ({Object.entries(plan.objectKinds).map(([kind, count]) => `${count} ${kind}`).join(', ') || 'none yet'}), in one transaction.</>,
                  <>Sign in as the new user to prove it works.</>,
                  <>Update the apps&apos; env files (originals are backed up) and restart each app, checking it comes back healthy.</>,
                ].map((text, index) => (
                  <li key={index} className="flex gap-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px]">{index + 1}</span><span className="text-muted-foreground">{text}</span></li>
                ))}
              </ol>

              <div className="space-y-2">
                <p className="text-sm font-medium">Apps that switch</p>
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {plan.apps.map(app => (
                    <div key={app.serviceId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="font-medium">{app.name}</span><span className="text-xs capitalize text-muted-foreground">{app.environment}</span>
                      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><FileCog className="h-3.5 w-3.5" />{app.files.length ? app.files.map(file => file.file).join(', ') : 'no settings found'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <ul className="space-y-1.5 text-xs text-muted-foreground">{plan.notes.map(note => <li key={note}>• {note}</li>)}<li>• If any app doesn&apos;t come back healthy, every app is put back on its previous settings and the database returns to its previous owner.</li></ul>

              {plan.blockers.length > 0 ? (
                <div role="alert" className="space-y-1.5 rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-300">
                  <p className="font-medium">Can&apos;t switch yet</p>
                  {plan.blockers.map(blocker => <p key={blocker} className="text-xs">{blocker}</p>)}
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-white" checked={understood} onChange={event => setUnderstood(event.target.checked)} disabled={running} />
                    <span>I understand {plan.apps.length === 1 ? 'the app restarts' : `these ${plan.apps.length} apps restart`}, with a few seconds of downtime each.</span>
                  </label>
                  <Button className="w-full" onClick={() => void run()} disabled={!understood || running}>
                    {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Switching… this can take a minute</> : <><ShieldCheck className="mr-2 h-4 w-4" />Switch to {plan.roleName}</>}
                  </Button>
                </>
              )}
            </>
          )}

          {result && (
            <div role={result.ok ? 'status' : 'alert'} className={result.ok ? 'space-y-2 rounded-lg border border-status-ready/25 bg-status-ready/5 p-4' : 'rounded-lg border border-red-400/25 bg-red-400/5 p-4 text-sm text-red-300'}>
              {result.ok ? <>
                <p className="flex items-center gap-2 text-sm font-medium text-emerald-200"><CheckCircle2 className="h-4 w-4" />Done. The apps now use their own database user.</p>
                <ul className="space-y-1 text-xs text-muted-foreground">{result.steps?.map(step => <li key={step} className="flex gap-2"><CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-status-ready" />{step}</li>)}</ul>
              </> : <p className="flex items-start gap-2"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{result.message}</p>}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
