'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Database, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { FrameworkLogo } from '@/components/synergy/framework-logo'
import { ChoiceCard, roleLabels } from './section'
import { ServiceCatalog, type ServerConnection } from './service-catalog'
import { providerMeta } from './providers'
import { cn } from '@/lib/utils'

interface App { id: string; name: string; component_role: string; project_type: string; environment: string }

const envName = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'DATABASE'

/**
 * Adds a database to a project: pick the engine (installing it if needed), the app
 * that owns it, and the other apps in the project that should use it too.
 */
export function ProjectServiceSheet({ open, onOpenChange, projectName, apps, appsWithMainDatabase, role, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName: string
  apps: App[]
  appsWithMainDatabase: string[]
  role: 'admin' | 'operator' | 'viewer'
  onCreated: (message: string) => void
}) {
  const eligible = useMemo(() => apps.filter(app => app.project_type !== 'angular'), [apps])
  const browserApps = apps.filter(app => app.project_type === 'angular')
  const [server, setServer] = useState<ServerConnection | null>(null)
  const [owner, setOwner] = useState('')
  const [users, setUsers] = useState<string[]>([])
  const [name, setName] = useState('primary')
  const [backup, setBackup] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const preferred = eligible.find(app => app.component_role === 'backend') || eligible[0]
    setServer(null); setOwner(preferred?.id || ''); setUsers([]); setName('primary'); setBackup(true); setError('')
    // Reset only when the sheet opens, not when the parent re-renders its app list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const create = async () => {
    if (!server || !owner) return
    setBusy(true); setError('')
    try {
      const ownerApp = eligible.find(app => app.id === owner)!
      const response = await fetch(`/api/sites/${owner}/data-services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        mode: 'provision', connectionId: server.id, name, envPrefix: envName(name), applicationPrimary: !appsWithMainDatabase.includes(owner),
        backupEnabled: server.provider === 'postgresql' && backup,
      }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Database could not be created')
      const failed: string[] = []
      for (const appId of users) {
        const shared = await fetch(`/api/sites/${appId}/data-services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          mode: 'shared', sourceServiceId: body.service.id, applicationPrimary: !appsWithMainDatabase.includes(appId),
        }) })
        if (!shared.ok) failed.push(eligible.find(app => app.id === appId)?.name || appId)
      }
      onOpenChange(false)
      onCreated(`${providerMeta[server.provider].label} database created for ${ownerApp.name}${users.length - failed.length ? ` and shared with ${users.length - failed.length} more ${users.length - failed.length === 1 ? 'app' : 'apps'}` : ''}. Credentials are injected at each app's next deployment.${failed.length ? ` Sharing failed for ${failed.join(', ')}.` : ''}`)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Add a service to {projectName}</SheetTitle>
          <SheetDescription>Create a database on this server and choose which apps in the project use it.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-7">
          <section className="space-y-3">
            <p className="text-sm font-medium"><span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border font-mono text-[10px]">1</span>Choose a service</p>
            <ServiceCatalog role={role} selectedConnectionId={server?.id} onSelect={setServer} />
          </section>

          <section className={cn('space-y-3', !server && 'pointer-events-none opacity-40')}>
            <p className="text-sm font-medium"><span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border font-mono text-[10px]">2</span>Which app owns it?</p>
            <p className="text-xs text-muted-foreground">The owner manages the password and backups. Usually the backend.</p>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Owner">
              {eligible.map(app => <ChoiceCard key={app.id} selected={owner === app.id} onSelect={() => { setOwner(app.id); setUsers(current => current.filter(id => id !== app.id)) }}
                icon={<FrameworkLogo type={app.project_type} className="h-5 w-5" />} title={app.name} description={roleLabels[app.component_role]} />)}
            </div>
            {!eligible.length && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Add a backend app to this project first. Browser apps can&apos;t hold database credentials.</p>}
          </section>

          {eligible.length > 1 && (
            <section className={cn('space-y-3', !server && 'pointer-events-none opacity-40')}>
              <p className="text-sm font-medium"><span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border font-mono text-[10px]">3</span>Also used by <span className="font-normal text-muted-foreground">optional</span></p>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {eligible.filter(app => app.id !== owner).map(app => {
                  const checked = users.includes(app.id)
                  return (
                    <button key={app.id} type="button" role="checkbox" aria-checked={checked} onClick={() => setUsers(current => checked ? current.filter(id => id !== app.id) : [...current, app.id])}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/[0.02]">
                      <span className={cn('flex h-4 w-4 items-center justify-center rounded border', checked ? 'border-foreground bg-foreground text-background' : 'border-white/30')}>{checked && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                      <FrameworkLogo type={app.project_type} className="h-4 w-4" />
                      <span className="flex-1">{app.name}</span>
                      <span className="text-xs text-muted-foreground">{roleLabels[app.component_role]}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
          {browserApps.length > 0 && <p className="text-xs text-muted-foreground">{browserApps.map(app => app.name).join(', ')} {browserApps.length === 1 ? 'runs' : 'run'} in the browser, so {browserApps.length === 1 ? 'it' : 'they'} reach the data through the backend instead.</p>}

          <section className={cn('space-y-3', !server && 'pointer-events-none opacity-40')}>
            <div className="divide-y divide-border rounded-lg border border-border">
              <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span className="font-medium">Name</span><input className="control-input h-8 w-48 font-mono text-xs" value={name} onChange={event => setName(event.target.value)} aria-label="Service name" /></label>
              {server?.provider === 'postgresql' && <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Daily backups</span><span className="block text-xs text-muted-foreground">Kept for 30 days.</span></span><Switch checked={backup} onCheckedChange={setBackup} /></label>}
            </div>
          </section>

          {error && <p role="alert" className="rounded-md border border-red-400/25 bg-red-400/5 px-3 py-2 text-sm text-red-300">{error}</p>}
          <Button className="w-full" onClick={() => void create()} disabled={busy || !server || !owner || !name.trim() || role !== 'admin'}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
            {server ? `Create ${providerMeta[server.provider].label} database` : 'Choose a service first'}
          </Button>
          {role !== 'admin' && <p className="text-center text-xs text-muted-foreground">Only administrators can create databases.</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
