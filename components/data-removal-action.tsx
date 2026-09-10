'use client'

import { useId, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface DataRemovalActionProps {
  kind: 'resource' | 'migration'
  name: string
  endpoint: string
  blockedReason: string | null | undefined
  disabled?: boolean
  onRemoved: () => Promise<void>
}

export function DataRemovalAction({ kind, name, endpoint, blockedReason, disabled, onRemoved }: DataRemovalActionProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonId = useId()
  const reason = blockedReason === undefined ? 'Refresh to check removal eligibility.' : blockedReason
  const label = kind === 'resource' ? 'Remove resource' : 'Delete migration history'

  const remove = async () => {
    if (busy || reason) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(endpoint, { method: 'DELETE' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Removal failed')
      setOpen(false)
      await onRemoved()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Removal failed') }
    finally { setBusy(false) }
  }

  return <>
    <span className="group relative inline-flex shrink-0" tabIndex={reason ? 0 : undefined} aria-label={reason || undefined} title={reason || label}>
      <Button variant="ghost" size="icon" aria-label={`${label}: ${name}`} aria-describedby={reason ? reasonId : undefined} disabled={disabled || busy || reason !== null} onClick={() => { setError(null); setOpen(true) }}>
        <Trash2 className="h-4 w-4" />
      </Button>
      {reason && <span id={reasonId} role="tooltip" className="pointer-events-none absolute right-0 top-full z-20 hidden w-60 whitespace-normal rounded-md border border-border bg-popover p-3 text-left text-xs font-normal text-popover-foreground shadow-md group-hover:block group-focus:block">{reason}</span>}
    </span>
    <Sheet open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{label}?</SheetTitle>
          <SheetDescription className="break-words">{name}</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5 text-sm">
          <p>{kind === 'resource'
            ? 'This removes the resource registration and its backup schedule from Manager. The database, database user and existing backup files will not be deleted. Existing application environment files will not be changed.'
            : 'This permanently removes this migration record, execution log and validation report. It does not undo the migration, delete source or target data, or change the application database.'}</p>
          {kind === 'resource' && <p className="text-muted-foreground">Credentials will no longer be available through this resource in Manager. Confirm that no application still relies on its managed environment settings.</p>}
          {reason && <p role="status" className="text-amber-400">{reason}</p>}
          {error && <p role="alert" className="break-words text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || reason !== null} onClick={() => void remove()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}{label}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </>
}
