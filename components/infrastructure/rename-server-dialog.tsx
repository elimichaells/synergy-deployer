'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, Pencil } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useServerDirectory } from '@/components/infrastructure/server-directory'

export function RenameServerDialog({ serverId, serverName, onRenamed }: { serverId: string; serverName: string; onRenamed?: (name: string) => void }) {
  const { refresh } = useServerDirectory(), inputId = useId()
  const [open, setOpen] = useState(false), [name, setName] = useState(''), [previousName, setPreviousName] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  function changeOpen(value: boolean) {
    if (busy) return
    if (value) { setName(serverName); setPreviousName(serverName); setError('') }
    setOpen(value)
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !name.trim() || name.trim() === previousName) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/servers/${serverId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), previousName }) })
      const result = await response.json()
      if (!response.ok) { if (response.status === 409) refresh(); throw new Error(result.error || 'Could not rename server') }
      refresh(); onRenamed?.(result.name); setOpen(false)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild><Button variant="outline" size="sm" aria-label={`Rename ${serverName}`}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] w-[calc(100%-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-6 shadow-2xl">
        <Dialog.Title className="text-lg font-semibold">Rename server</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">Choose the name shown for this server in Manager.</Dialog.Description>
        <form onSubmit={save} className="mt-4 space-y-4">
          <div><label htmlFor={inputId} className="text-sm font-medium">Server name</label><input id={inputId} required maxLength={100} autoComplete="off" value={name} onChange={event => setName(event.target.value)} disabled={busy} className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring" /></div>
          {error && <p role="alert" className="notice-error">{error}</p>}
          <div className="flex justify-end gap-2"><Dialog.Close asChild><Button type="button" variant="outline" disabled={busy}>Cancel</Button></Dialog.Close><Button type="submit" disabled={busy || !name.trim() || name.trim() === previousName}>{busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : 'Save name'}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
