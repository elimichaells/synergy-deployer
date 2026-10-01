'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Link2, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface AppOption { id: string; name: string; environment: string; application_group_name: string | null }

/** Add a database: pick the app it is for, then create or connect it from that app's Storage tab. */
export function AddDatabaseSheet({ open, onOpenChange, unlinked }: { open: boolean; onOpenChange: (open: boolean) => void; unlinked: number }) {
  const [apps, setApps] = useState<AppOption[] | null>(null)
  const [appId, setAppId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || apps) return
    void fetch('/api/sites', { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => [])
      if (!response.ok) throw new Error(body.error || 'Could not load your apps')
      const list = (Array.isArray(body) ? body : body.projects || []) as AppOption[]
      setApps(list); setAppId(list[0]?.id || '')
    }).catch(err => { setError((err as Error).message); setApps([]) })
  }, [open, apps])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add a database</SheetTitle>
          <SheetDescription>Every database belongs to an app, so Synergy can give the app its connection details.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-6">
          {unlinked > 0 && <p className="flex items-start gap-2 rounded-lg border border-status-building/30 bg-status-building/[0.04] p-3 text-xs leading-5 text-muted-foreground"><Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />{unlinked} database{unlinked === 1 ? ' that an app already uses was' : 's that apps already use were'} found and aren&apos;t linked yet. Link {unlinked === 1 ? 'it' : 'them'} from the notice on this page instead of adding a new one.</p>}
          <label className="field-label">Which app is it for?
            {apps === null ? <span className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading apps…</span>
              : <select className="control-input" value={appId} onChange={event => setAppId(event.target.value)}>
                {apps.map(app => <option key={app.id} value={app.id}>{app.name} · {app.environment}{app.application_group_name ? ` · ${app.application_group_name}` : ''}</option>)}
              </select>}
          </label>
          {error && <p role="alert" className="notice-error">{error}</p>}
          {apps && !apps.length && !error && <p className="text-sm text-muted-foreground">You have no apps yet. <Link href="/sites/new" className="text-foreground underline-offset-4 hover:underline">Create one first</Link>.</p>}
          <Button asChild className="w-full" disabled={!appId}>
            <Link href={appId ? `/sites/${appId}?tab=storage` : '#'}><Plus className="mr-2 h-4 w-4" />Continue to the app&apos;s storage<ArrowRight className="ml-2 h-4 w-4" /></Link>
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">There you can create a new database on a Synergy server, connect one that already exists, or share another app&apos;s database in the same project.</p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
