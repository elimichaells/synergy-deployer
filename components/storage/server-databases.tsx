'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, Check, Copy, Database, Eye, Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes } from '@/lib/format'
import { ControlBackupsPanel } from './control-backups-panel'
import { DataTab } from './data-tab'
import { SqlTab } from './sql-tab'

interface Server { id: string; name: string; provider: string; username: string | null }
interface Entry {
  id: string; tracked: boolean; name: string; sizeBytes: number | null; owner: string | null
  apps: { name: string; environment: string }[]; configuredFor: string[]
  backup: { frequency: string; enabled: boolean; lastStatus: string; legacy?: boolean } | null; dropBlocker: string | null
}
interface Listing { server: { id: string; name: string; system: boolean }; databases: Entry[] }

/** Every database on each PostgreSQL server Synergy can sign in to, including ones no app uses. */
export function ServerDatabases({ servers, isAdmin }: { servers: Server[]; isAdmin: boolean }) {
  const eligible = servers.filter(server => server.provider === 'postgresql' && server.username)
  if (!isAdmin || !eligible.length) return null
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Databases on each server</h2>
        <p className="text-xs text-muted-foreground">Everything a server holds, including databases no app uses. Browse, back up or remove the ones that are not in use.</p>
      </div>
      {eligible.map(server => <ServerBlock key={server.id} server={server} />)}
    </section>
  )
}

function ServerBlock({ server }: { server: Server }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Entry | null>(null)
  const [dropping, setDropping] = useState<Entry | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const response = await fetch(`/api/storage/servers/${server.id}/databases`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not list the databases')
    setListing(body)
  }, [server.id])
  useEffect(() => { void load().catch(err => setError((err as Error).message)) }, [load])

  const total = (listing?.databases || []).reduce((sum, database) => sum + (database.sizeBytes || 0), 0)
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div>
          <p className="text-sm font-medium">{server.name}</p>
          <p className="text-xs text-muted-foreground">{listing ? `${listing.databases.length} databases · ${formatBytes(total)}` : error ? 'Unavailable' : 'Loading…'}</p>
        </div>
        {listing && !listing.server.system && <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="mr-1.5 h-3.5 w-3.5" />Create database</Button>}
      </div>
      {error && <p role="alert" className="px-5 py-4 text-sm text-red-300">{error}</p>}
      {!listing && !error && <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Reading the server…</div>}
      {listing && (
        <div className="divide-y divide-border">
          {listing.databases.map(database => (
            <div key={database.name} className="grid items-center gap-3 px-5 py-3 text-sm md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_90px_auto]">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium">{database.name}</p>
                <p className="truncate text-xs text-muted-foreground">{database.owner ? `Owner ${database.owner}` : ''}</p>
              </div>
              <div className="min-w-0 text-xs text-muted-foreground">
                {database.tracked
                  ? <span>Used by <span className="text-foreground">{[...new Set(database.apps.map(app => app.name))].join(', ')}</span></span>
                  : database.configuredFor.length
                    ? <span className="text-amber-300">Set in {database.configuredFor.join(', ')} but not linked</span>
                    : <span className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-status-building" />Not used by any app</span>}
                {database.backup && <span className="mt-0.5 block">Backed up {database.backup.frequency}{database.backup.enabled ? '' : ' (paused)'}</span>}
              </div>
              <span className="text-xs text-muted-foreground md:text-right">{formatBytes(database.sizeBytes)}</span>
              <div className="flex items-center justify-end gap-1">
                {database.tracked
                  ? <Button asChild size="sm" variant="outline"><Link href={`/storage/${database.id}`}>Open<ArrowUpRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
                  : <Button size="sm" variant="outline" onClick={() => setOpen(database)}><Eye className="mr-1.5 h-3.5 w-3.5" />Browse</Button>}
                {!database.tracked && <Button size="sm" variant="ghost" aria-label={`Drop ${database.name}`} title={database.dropBlocker || 'Drop this database'} disabled={!!database.dropBlocker} onClick={() => setDropping(database)}><Trash2 className="h-3.5 w-3.5" /></Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <UntrackedSheet entry={open} system={!!listing?.server.system} onOpenChange={value => { if (!value) setOpen(null) }} />
      <DropSheet serverId={server.id} entry={dropping} onClose={() => setDropping(null)} onDropped={() => { setDropping(null); void load().catch(err => setError((err as Error).message)) }} />
      <CreateSheet serverId={server.id} open={creating} onOpenChange={setCreating} onCreated={() => void load().catch(err => setError((err as Error).message))} />
    </div>
  )
}

/** Data, SQL and backups for a database no app tracks. */
function UntrackedSheet({ entry, system, onOpenChange }: { entry: Entry | null; system: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-4xl">
        {entry && <>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><Database className="h-4 w-4" /><span className="font-mono">{entry.name}</span></SheetTitle>
            <SheetDescription>No app uses this database. You can look at its data, run SQL, and manage its backups here.</SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="data" className="mt-6">
            <TabsList><TabsTrigger value="data">Data</TabsTrigger><TabsTrigger value="sql">SQL</TabsTrigger><TabsTrigger value="backups">Backups</TabsTrigger></TabsList>
            <TabsContent value="data" className="mt-5"><DataTab serviceId={entry.id} /></TabsContent>
            <TabsContent value="sql" className="mt-5"><SqlTab serviceId={entry.id} database={entry.name} /></TabsContent>
            <TabsContent value="backups" className="mt-5">
              {system
                ? <ControlBackupsPanel database={entry.name} isAdmin />
                : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">Backups are scheduled per app. Link this database to an app from the app&apos;s Storage tab, then schedule its backups here.</p>}
            </TabsContent>
          </Tabs>
        </>}
      </SheetContent>
    </Sheet>
  )
}

function DropSheet({ serverId, entry, onClose, onDropped }: { serverId: string; entry: Entry | null; onClose: () => void; onDropped: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setTyped(''); setError('') }, [entry])
  const drop = async () => {
    if (!entry) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/storage/servers/${serverId}/databases/${encodeURIComponent(entry.name)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: typed }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The database could not be dropped')
      onDropped()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet open={!!entry} onOpenChange={value => { if (!value && !busy) onClose() }}>
      <SheetContent className="w-full sm:max-w-md">
        {entry && <>
          <SheetHeader>
            <SheetTitle>Drop {entry.name}?</SheetTitle>
            <SheetDescription>This permanently deletes the database and everything in it. It cannot be undone, and existing backups are kept only if you made them.</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            {entry.backup ? <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">It is backed up {entry.backup.frequency}; those backup files stay on this server after the drop.</p>
              : <p className="rounded-lg border border-status-building/30 bg-status-building/[0.04] p-3 text-xs text-muted-foreground">It has no backups. Make one first if you might need the data.</p>}
            <label className="field-label">Type <span className="font-mono text-foreground">{entry.name}</span> to confirm
              <input className="control-input font-mono" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            {error && <p role="alert" className="notice-error">{error}</p>}
            <Button variant="outline" className="w-full border-red-500/40 text-red-300 hover:bg-red-500/10" onClick={() => void drop()} disabled={busy || typed !== entry.name}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Drop database</Button>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  )
}

function CreateSheet({ serverId, open, onOpenChange, onCreated }: { serverId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [withOwner, setWithOwner] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ database: string; owner?: { username: string; password: string } } | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => { if (open) { setName(''); setWithOwner(true); setError(''); setCreated(null); setCopied(false) } }, [open])
  const create = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/storage/servers/${serverId}/databases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, withOwner }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The database could not be created')
      setCreated(body); onCreated()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Create a database</SheetTitle>
          <SheetDescription>Creates an empty database on this server. To give an app its own database with the connection set up automatically, add it from the app&apos;s Storage tab instead.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-4">
          {!created ? <>
            <label className="field-label">Database name<input className="control-input font-mono" value={name} onChange={event => setName(event.target.value)} placeholder="my_database" autoComplete="off" spellCheck={false} /></label>
            <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-white" checked={withOwner} onChange={event => setWithOwner(event.target.checked)} /><span>Also create a login that owns it<span className="mt-0.5 block text-xs text-muted-foreground">Recommended. Named <span className="font-mono">{name || 'name'}_user</span>, with a generated password shown once.</span></span></label>
            {error && <p role="alert" className="notice-error">{error}</p>}
            <Button className="w-full" onClick={() => void create()} disabled={busy || !name.trim()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create database</Button>
          </> : <>
            <p role="status" className="rounded-md border border-status-ready/25 bg-status-ready/5 px-4 py-3 text-sm text-emerald-200">Created <span className="font-mono">{created.database}</span>.</p>
            {created.owner && <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
              <p className="font-medium">Save this password now</p>
              <p className="text-xs text-muted-foreground">It is shown only once and is not stored anywhere Synergy can show it again.</p>
              <dl className="summary-list"><div><dt>User</dt><dd className="font-mono text-xs">{created.owner.username}</dd></div><div><dt>Password</dt><dd className="break-all font-mono text-xs">{created.owner.password}</dd></div></dl>
              <Button size="sm" variant="outline" onClick={async () => { await navigator.clipboard.writeText(created.owner!.password); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}Copy password</Button>
            </div>}
            <Button className="w-full" variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
          </>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
