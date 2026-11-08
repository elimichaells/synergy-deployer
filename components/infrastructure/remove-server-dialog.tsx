'use client'

import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useServerDirectory } from '@/components/infrastructure/server-directory'
import type { ServerRemovalReview } from '@/lib/server-removal-types'

export function RemoveServerDialog({ serverId, serverName, leaveWorkspace = false, disabled = false, onRemoved }: { serverId: string; serverName: string; leaveWorkspace?: boolean; disabled?: boolean; onRemoved?: () => void }) {
  const router = useRouter(), { refresh } = useServerDirectory(), inputId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0)
  const [review, setReview] = useState<ServerRemovalReview | null>(null)
  const [name, setName] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setReview(null); setName(''); setAcknowledged(false); setError(''); setLoading(true)
    void (async () => {
      try {
        const response = await fetch(`/api/servers/${serverId}/removal`, { cache: 'no-store', signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not review this server')
        if (!controller.signal.aborted) setReview(result)
      } catch (err) { if (!controller.signal.aborted) setError((err as Error).message) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [open, serverId, revision])

  async function remove() {
    if (!review) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/servers/${serverId}/removal`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewToken: review.reviewToken, confirmationName: name, acknowledged }) })
      const result = await response.json()
      if (!response.ok) { if (response.status === 409) setReview(null); throw new Error(result.error || 'Could not remove server') }
      setOpen(false); refresh(); onRemoved?.()
      if (leaveWorkspace) router.replace('/')
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  return <AlertDialog.Root open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
    <AlertDialog.Trigger asChild><Button variant="outline" size="sm" disabled={disabled} aria-label={`Remove ${serverName}`} className="text-destructive hover:text-destructive"><Trash2 className="mr-1.5 h-3.5 w-3.5" />Remove server</Button></AlertDialog.Trigger>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm" />
      <AlertDialog.Content onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus() }} className="fixed left-1/2 top-1/2 z-[71] max-h-[90dvh] w-[calc(100%-32px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-6 shadow-2xl">
        <AlertDialog.Title ref={title} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none"><AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />Remove server from Manager?</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 break-words text-sm leading-6 text-muted-foreground">Remove <strong className="text-foreground">{review?.server.name || serverName}</strong> and permanently delete its records in Manager. This cannot be undone.</AlertDialog.Description>
        {loading && <p role="status" className="mt-4 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Checking applications and active work…</p>}
        {review && <div className="mt-4 space-y-4 text-sm">
          <div className="rounded-lg border border-border bg-muted/30 p-4 leading-6"><p className="font-medium">The server and its sites stay running</p><p className="mt-1 text-muted-foreground">Applications, databases, files, Caddy, other installed services and DNS records stay on the server or with their provider. The agent remains installed, but its Manager credential stops working. Server and provider charges continue.</p></div>
          {review.requiresConfirmation ? <>
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 leading-6">
              <p className="font-semibold text-destructive">You will lose management access and saved records</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Deployments, monitoring, console access, runtime controls and agent updates stop through this connection.</li>
                <li>{review.applications.length} application record{review.applications.length === 1 ? '' : 's'}, {review.domains.length} domain record{review.domains.length === 1 ? '' : 's'}, {review.history.jobs} job record{review.history.jobs === 1 ? '' : 's'}, health history, saved environment values and service credentials are deleted from Manager.</li>
                <li>{review.queuedOperations} queued operation{review.queuedOperations === 1 ? '' : 's'} will never start through this connection. Previously revoked work may still finish on the server.</li>
                <li>Export any configuration and credentials you need first. Reconnecting requires new enrollment and importing applications again; it does not restore this history.</li>
              </ul>
            </div>
            {!!review.applications.length && <div><p className="font-medium">Applications losing management</p><ul className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border p-3">{review.applications.map(app => <li key={app.id} className="break-words">{app.name}<span className="text-muted-foreground"> · {app.environment_name}{app.deployed_at ? ' · deployed' : ''}</span></li>)}</ul></div>}
            <p className="text-xs leading-5 text-muted-foreground">The removal audit is retained. Existing backups may still contain earlier records.</p>
          </> : <p className="leading-6 text-muted-foreground">This server has not enrolled and has no application or operation records. Its enrollment link will stop working. Any partially installed files or services remain on the server.</p>}
          {!!review.blockers.length && <div role="alert" className="notice-error"><p className="font-medium">Resolve active work before removal</p><ul className="mt-2 list-disc space-y-2 pl-4">{review.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}
          {review.requiresConfirmation && !review.blockers.length && <>
            <div><label htmlFor={inputId} className="block break-words font-medium">Type “{review.server.name}” to confirm</label><input id={inputId} autoComplete="off" spellCheck={false} value={name} onChange={event => setName(event.target.value)} disabled={busy} className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring" /></div>
            <label className="flex items-start gap-2 leading-5"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy} className="mt-1 shrink-0" /><span>I understand that Manager access, saved credentials and management history will be lost, and I am responsible for the services left running.</span></label>
          </>}
        </div>}
        {error && <p role="alert" className="notice-error mt-4">{error}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <AlertDialog.Cancel asChild><Button variant="outline" disabled={busy}>Keep server</Button></AlertDialog.Cancel>
          {(!review || !!review.blockers.length) && !loading && <Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh review</Button>}
          <Button variant="destructive" disabled={loading || busy || !review || !!review.blockers.length || (review.requiresConfirmation && (name !== review.server.name || !acknowledged))} onClick={() => void remove()}>{busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Removing…</> : 'Remove from Manager'}</Button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
}
