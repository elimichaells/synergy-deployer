'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { RenamePlan } from '@/lib/database-rename'

export function RenameDatabaseSheet({ serviceId, open, onOpenChange, onDone }: { serviceId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const [plan, setPlan] = useState<RenamePlan | null>(null)
  const [name, setName] = useState(''), [confirm, setConfirm] = useState('')
  const [acknowledge, setAcknowledge] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const load = async () => {
    setError('')
    try {
      const response = await fetch(`/api/storage/${encodeURIComponent(serviceId)}/rename`, { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not review the rename')
      setPlan(body.plan)
    } catch (error) { setError((error as Error).message) }
  }
  useEffect(() => {
    if (!open) return
    setPlan(null); setName(''); setConfirm(''); setAcknowledge(false); setMessage('')
    void load()
    // The service identity changes only when a different database is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serviceId])
  const rename = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/storage/${encodeURIComponent(serviceId)}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName: name, confirm, acknowledge }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Rename failed')
      setMessage(body.message); onDone()
    } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  return <Sheet open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
    <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader><SheetTitle>Rename database</SheetTitle><SheetDescription>Changes the PostgreSQL database name and Manager links. All data and login credentials stay the same.</SheetDescription></SheetHeader>
      <div className="mt-6 space-y-5">
        {error && <p role="alert" className="notice-error">{error}</p>}
        {message ? <p role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm">{message}</p> : <>
          {!plan && !error && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Checking connections…</p>}
          {plan && <>
            <p className="text-sm"><span className="font-mono">{plan.database}</span> on {plan.server}</p>
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm space-y-2">
              <p className="font-medium">Every app using this database needs the new name</p>
              <p>Stop the apps and workers first. After renaming, update the database name in each saved .env file, connection URL, deployment secret and external client, then restart or redeploy all affected apps.</p>
              <p>Manager updates Storage links and backup schedules. It does not edit .env files or restart apps. Managed connection variables use the new name on the next deployment; saved settings and custom variables still need review.</p>
            </div>
            <div className="space-y-3">
              <p className="text-sm font-medium">Apps and settings Manager can identify</p>
              {plan.apps.length ? plan.apps.map(app => <div key={app.projectId} className="rounded-lg border border-border p-3 text-sm">
                <Link className="underline" href={`/sites/${app.projectId}?tab=environment`}>{app.name}</Link> · {app.environment}
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{app.settings.map(setting => <li key={setting} className="break-all font-mono">{setting}</li>)}</ul>
              </div>) : <p className="text-sm text-muted-foreground">No saved app settings or Manager links were found.</p>}
              <p className="text-xs text-muted-foreground">Also check apps outside Manager, CI secrets, containers, workers and external clients. These may not appear here.</p>
            </div>
            {!!plan.sessions.length && <ul className="text-sm">{plan.sessions.map((session, index) => <li key={index}>{session.application}: {session.count} active connection(s)</li>)}</ul>}
            {!!plan.blockers.length && <div role="alert" className="notice-error"><ul className="space-y-2">{plan.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>Refresh checks</Button>
            <label className="field-label">New database name<input className="control-input font-mono" value={name} onChange={event => setName(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="field-label">Type {plan.database} to confirm<input className="control-input font-mono" value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} /><span>I understand I must update connections for every app sharing this database and restart or redeploy them.</span></label>
            <Button className="w-full" disabled={busy || !!plan.blockers.length || !name || name === plan.database || confirm !== plan.database || !acknowledge} onClick={() => void rename()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Rename database</Button>
          </>}
        </>}
      </div>
    </SheetContent>
  </Sheet>
}
