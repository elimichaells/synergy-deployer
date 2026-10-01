'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, Database, KeyRound, Layers, Link2, Loader2, MoreHorizontal, Plus, RefreshCw, Sparkles, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { DataMigrationWizard } from '@/components/data-migration-wizard'
import { DataRemovalAction } from '@/components/data-removal-action'
import { ChoiceCard, Section, roleLabels } from './section'
import { cn } from '@/lib/utils'

import { ProviderLogo, providerMeta, type Provider } from './providers'
import { ServiceCatalog, type ServerConnection } from './service-catalog'

export { ProviderLogo, providerMeta }

interface Service {
  id: string
  name: string
  provider: Provider
  connection_name: string
  database_name: string
  username: string | null
  env_prefix: string
  application_primary: boolean
  removal_blocked_reason: string | null
  backup_status?: string | null
  shared_from_project_name?: string | null
  shared_with?: string[] | null
  options: { ownership?: 'manager' | 'external' | 'shared' | 'adopted' }
}

interface Connection { id: string; name: string; provider: Provider; host: string; port: number; last_status: string; is_default: boolean; provisioning_enabled: boolean }
interface Shareable { id: string; name: string; database_name: string; project_id: string; project_name: string; component_role: string; provider: Provider; connection_name: string; already_shared: boolean }
interface LegacyDatabase { database_name: string; role_name: string }

const menuItem = 'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground'
const envName = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'DATABASE'

function envLabel(service: Service, projectType: string) {
  if (!service.application_primary) return `${service.env_prefix}_URL, ${service.env_prefix}_HOST…`
  if (projectType === 'next' || projectType === 'node') return 'DATABASE_URL and DATABASE_*'
  if (service.provider === 'mongodb') return 'MONGODB_URI'
  if (service.provider === 'redis') return 'REDIS_URL'
  return 'DB_CONNECTION, DB_HOST, DB_DATABASE…'
}

type AddMode = 'new' | 'stack' | 'existing'

export function StoragePanel({ projectId, projectName, projectType, role, onChanged, intro }: {
  projectId: string
  projectName: string
  projectType: string
  role: 'admin' | 'operator' | 'viewer'
  onChanged?: () => void
  /** Rendered above the list, e.g. setup guidance. */
  intro?: React.ReactNode
}) {
  const [services, setServices] = useState<Service[] | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [shareable, setShareable] = useState<Shareable[]>([])
  const [legacy, setLegacy] = useState<LegacyDatabase | null>(null)
  const [found, setFound] = useState<{ source: string; engine: string; database: string; host: string; port: number; connectionName: string | null; superuser: boolean }[]>([])
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<AddMode>('new')
  const [form, setForm] = useState({ connectionId: '', name: 'primary', envPrefix: 'PRIMARY', databaseName: '', customCredentials: false, username: '', password: '', confirm: '', applicationPrimary: true, backup: true, syncEnv: false, sourceServiceId: '' })
  const [passwordFor, setPasswordFor] = useState<Service | null>(null)
  const [password, setPassword] = useState({ value: '', confirm: '' })
  const isAdmin = role === 'admin'
  const browserApp = projectType === 'angular'

  const load = useCallback(async () => {
    const [servicesRes, connectionsRes, shareableRes, legacyRes] = await Promise.all([
      fetch(`/api/sites/${projectId}/data-services`, { cache: 'no-store' }),
      fetch('/api/data/connections'),
      fetch(`/api/sites/${projectId}/data-services/shareable`, { cache: 'no-store' }),
      fetch(`/api/sites/${projectId}/database`),
    ])
    if (!servicesRes.ok) throw new Error('Could not load databases')
    setServices((await servicesRes.json()).services || [])
    if (connectionsRes.ok) setConnections((await connectionsRes.json()).connections || [])
    if (shareableRes.ok) setShareable((await shareableRes.json()).services || [])
    if (legacyRes.ok) setLegacy((await legacyRes.json()).database || null)
    const discoverRes = await fetch(`/api/storage/discover?project=${projectId}`, { cache: 'no-store' }).catch(() => null)
    setFound(discoverRes?.ok ? (await discoverRes.json()).discovered || [] : [])
  }, [projectId])

  useEffect(() => { void load().catch(error => setNotice({ tone: 'error', text: error.message })) }, [load])

  const refresh = async () => { await load(); onChanged?.() }
  const available = useMemo(() => shareable.filter(item => !item.already_shared), [shareable])
  const usableConnections = connections.filter(connection => connection.provisioning_enabled && connection.last_status === 'healthy')
  const [selectedServer, setSelectedServer] = useState<ServerConnection | null>(null)
  const selectedConnection = connections.find(connection => connection.id === form.connectionId) || (selectedServer?.id === form.connectionId ? selectedServer : undefined)
  const hasPrimary = !!services?.some(service => service.application_primary)

  const openAdd = (next: AddMode) => {
    const recommended = usableConnections.find(connection => connection.is_default) || usableConnections[0]
    setMode(next)
    setForm(current => ({ ...current, connectionId: next === 'new' ? recommended?.id || '' : next === 'existing' ? connections[0]?.id || '' : '',
      name: 'primary', envPrefix: 'PRIMARY', databaseName: '', customCredentials: false, username: '', password: '', confirm: '',
      applicationPrimary: !hasPrimary, backup: true, syncEnv: false, sourceServiceId: available[0]?.id || '' }))
    setNotice(null)
    setOpen(true)
  }

  const sync = async (options: { preview?: boolean; confirmApplicationChange?: boolean } = {}) => {
    const response = await fetch(`/api/sites/${projectId}/data-services/sync-env`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '.env', restart: !options.preview, preview: options.preview, confirmApplicationChange: options.confirmApplicationChange }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Database variables could not be written to .env')
    return body
  }

  const confirmAndSync = async () => {
    const preview = await sync({ preview: true })
    if (preview.runtimeBlockers?.length) throw new Error(preview.runtimeBlockers.join(' '))
    if (preview.changesApplicationDatabase && !window.confirm(`Switch ${projectName} to ${preview.activeService?.provider || 'the selected database'} ${preview.activeService?.database_name || ''}? Synergy backs up .env and restarts only this application.`)) return null
    return sync({ confirmApplicationChange: preview.changesApplicationDatabase })
  }

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true); setNotice(null)
    try {
      const message = await action()
      if (message) setNotice({ tone: 'ok', text: message })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Operation failed' })
    } finally { setBusy(false) }
  }

  const link = (source: string) => run(async () => {
    const response = await fetch('/api/storage/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, source }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'The database could not be linked')
    await refresh()
    return `Linked ${body.database}. The app keeps using its own settings; Synergy now tracks it for backups and status.`
  })

  const syncEnv = () => run(async () => {
    const body = await confirmAndSync()
    if (!body) return 'Nothing changed. Variables are still injected automatically at the next deployment.'
    return `${body.keys.length} variables written to .env${body.restart?.success ? ' and the application restarted' : '; restart needs attention'}.`
  })

  const create = () => run(async () => {
    if ((mode === 'existing' || form.customCredentials) && form.password !== form.confirm) throw new Error('Password confirmation does not match')
    const body = mode === 'stack'
      ? { mode: 'shared', sourceServiceId: form.sourceServiceId, applicationPrimary: form.applicationPrimary, envPrefix: form.envPrefix || undefined }
      : {
        mode: mode === 'existing' ? 'existing' : 'provision', connectionId: form.connectionId, name: form.name, envPrefix: form.envPrefix,
        databaseName: form.databaseName, username: mode === 'existing' || form.customCredentials ? form.username : '',
        password: mode === 'existing' || form.customCredentials ? form.password : '', applicationPrimary: form.applicationPrimary,
        backupEnabled: selectedConnection?.provider === 'postgresql' && form.backup,
      }
    const response = await fetch(`/api/sites/${projectId}/data-services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Database could not be added')
    setOpen(false)
    let tail = 'Its credentials are injected automatically at the next deployment.'
    if (form.syncEnv) {
      const synced = await confirmAndSync().catch(error => { tail = `.env sync needs attention: ${error.message}`; return undefined })
      if (synced) tail = `${synced.keys.length} variables were written to .env.`
    }
    await refresh()
    return `${mode === 'stack' ? 'Project database connected' : mode === 'existing' ? 'Existing database connected' : 'Database created'}. ${tail}`
  })

  const makePrimary = (service: Service) => run(async () => {
    if (!window.confirm(`Use ${service.database_name} as ${projectName}'s main database? Its standard variables (for example DATABASE_URL) will point at it from the next deployment.`)) return
    const response = await fetch(`/api/sites/${projectId}/data-services/${service.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applicationPrimary: true }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not change the main database')
    await refresh()
    return `${service.database_name} is now the main database. Redeploy or sync .env to switch the running app.`
  })

  const rotate = () => run(async () => {
    if (!passwordFor) return
    if (password.value !== password.confirm) throw new Error('Password confirmation does not match')
    const response = await fetch(`/api/sites/${projectId}/data-services/${passwordFor.id}/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Password could not be changed')
    setPasswordFor(null); setPassword({ value: '', confirm: '' })
    const synced = await sync().catch(() => null)
    await refresh()
    return `Password changed and verified${passwordFor.shared_with?.length ? `, including for ${passwordFor.shared_with.join(', ')}` : ''}.${synced ? ' .env was updated and the app restarted.' : ' Redeploy to pick it up.'}`
  })

  const legacyAction = (action: 'rotate_password') => run(async () => {
    const response = await fetch(`/api/sites/${projectId}/database`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Database operation failed')
    setLegacy(body.database)
    return 'Password rotated. Redeploy the application to refresh its environment.'
  })

  if (browserApp) {
    return (
      <Section title="Storage" description="Browser applications never hold database credentials. Connect the database to your backend API, then call that API from this app.">
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Add the database to this project&apos;s backend; the frontend calls the backend&apos;s API.</p>
      </Section>
    )
  }

  const canSubmit = mode === 'stack' ? !!form.sourceServiceId
    : !!form.connectionId && !!form.name && !!form.envPrefix && (mode === 'new'
      ? !form.customCredentials || (form.password.length >= 16 && form.password === form.confirm)
      : !!form.databaseName && !!form.username && !!form.password)

  return (
    <div className="space-y-4">
      {intro}
      {found.length > 0 && (
        <div className="rounded-xl border border-status-building/30 bg-status-building/[0.04] p-4">
          <p className="text-sm font-medium">{found.length === 1 ? "This app already uses a database Synergy doesn't track" : `This app already uses ${found.length} databases Synergy doesn't track`}</p>
          <p className="mt-1 text-xs text-muted-foreground">Found in its environment file. Linking adds it to Storage for backups, browsing and status. The app keeps its current settings; nothing is changed.</p>
          <div className="mt-3 space-y-2">{found.map(item => (
            <div key={item.source} className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
              <ProviderLogo provider={item.engine as Provider} size="sm" />
              <span className="min-w-0 flex-1"><span className="block truncate font-mono">{item.database}</span><span className="block truncate text-xs text-muted-foreground">{item.connectionName || `:`} · {item.source}{item.superuser ? ' · superuser account' : ''}</span></span>
              <Button size="sm" variant="outline" disabled={!isAdmin || busy} onClick={() => void link(item.source)}>Link</Button>
            </div>
          ))}</div>
        </div>
      )}
      <Section
        title="Databases"
        description={<>Databases connected to this application. Synergy keeps their credentials encrypted and injects them as environment variables on every deployment.</>}
        action={services && services.length > 0 ? <>
          {isAdmin && <DataMigrationWizard projectId={projectId} projectName={projectName} services={services} canRemove={isAdmin} onAddService={() => openAdd('new')}
            onActivated={async () => { const body = await confirmAndSync().catch(() => null); await refresh(); return !!body }} onChanged={refresh} />}
          <Button size="sm" onClick={() => openAdd(available.length ? 'stack' : 'new')} disabled={!isAdmin}><Plus className="mr-1.5 h-4 w-4" />Add database</Button>
        </> : undefined}
        footer={services && services.length > 0 ? <>
          <span>Variables are injected automatically at deploy time. Write them to <code className="font-mono text-xs">.env</code> only if you run commands by hand.</span>
          <Button variant="outline" size="sm" onClick={() => void syncEnv()} disabled={busy || role === 'viewer'}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', busy && 'animate-spin')} />Sync .env now</Button>
        </> : undefined}
      >
        {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('mb-4 rounded-md border px-3 py-2 text-sm', notice.tone === 'error' ? 'border-red-400/25 bg-red-400/5 text-red-300' : 'border-status-ready/25 bg-status-ready/5 text-emerald-200')}>{notice.text}</p>}
        {services === null ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading databases" /></div>
        ) : services.length > 0 ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {services.map(service => (
              <div key={service.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5">
                <ProviderLogo provider={service.provider} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-mono text-sm font-medium">{service.provider === 'redis' ? `${service.name} · db ${service.database_name}` : service.database_name}</p>
                    {service.application_primary && <span className="flex items-center gap-1 rounded-full border border-white/15 bg-white/[0.06] px-2 py-px text-[11px] font-medium"><Star className="h-3 w-3" />Main database</span>}
                    {service.options?.ownership === 'shared' && <span className="flex items-center gap-1 rounded-full border border-syn-violet/30 bg-syn-violet/10 px-2 py-px text-[11px] text-violet-200"><Layers className="h-3 w-3" />From {service.shared_from_project_name || 'project'}</span>}
                    {!!service.shared_with?.length && <span className="flex items-center gap-1 rounded-full border border-syn-cyan/30 bg-syn-cyan/10 px-2 py-px text-[11px] text-cyan-200"><Layers className="h-3 w-3" />Shared with {service.shared_with.join(', ')}</span>}
                    {service.options?.ownership === 'external' && <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground">External</span>}
                    {service.options?.ownership === 'adopted' && <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground" title="Synergy tracks this database; the app keeps its own settings in .env">Configured in the app&apos;s .env</span>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{providerMeta[service.provider]?.label} on {service.connection_name} · env <span className="font-mono">{envLabel(service, projectType)}</span></p>
                </div>
                <div className="flex items-center gap-1">
                  {isAdmin && <DataRemovalAction kind="resource" name={service.database_name} endpoint={`/api/sites/${projectId}/data-services/${service.id}`} blockedReason={service.removal_blocked_reason} disabled={busy} onRemoved={refresh} />}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild><button type="button" className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.07] hover:text-foreground" aria-label={`Actions for ${service.database_name}`}><MoreHorizontal className="h-4 w-4" /></button></DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-56 rounded-lg border border-white/10 bg-popover p-1 shadow-2xl shadow-black/60">
                        <DropdownMenu.Item className={menuItem} disabled={service.application_primary || role === 'viewer' || service.options?.ownership === 'adopted'} onSelect={() => void makePrimary(service)}><Star className="h-3.5 w-3.5" />Make main database</DropdownMenu.Item>
                        <DropdownMenu.Item className={menuItem} disabled={!isAdmin || !!service.options?.ownership && service.options.ownership !== 'manager' || service.provider === 'redis'} onSelect={() => { setPasswordFor(service); setPassword({ value: '', confirm: '' }) }}><KeyRound className="h-3.5 w-3.5" />Change password</DropdownMenu.Item>
                        {['mysql', 'mariadb'].includes(service.provider) && <DropdownMenu.Item asChild className={menuItem}><a href="/mysql/" target="_blank" rel="noreferrer"><ArrowUpRight className="h-3.5 w-3.5" />Open phpMyAdmin</a></DropdownMenu.Item>}
                        <DropdownMenu.Item asChild className={menuItem}><Link href={`/data-services?project=${projectId}`}><Database className="h-3.5 w-3.5" />Backups & advanced</Link></DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            ))}
          </div>
        ) : legacy ? (
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border px-4 py-3.5">
            <ProviderLogo provider="postgresql" />
            <div className="min-w-0 flex-1"><p className="font-mono text-sm font-medium">{legacy.database_name}</p><p className="text-xs text-muted-foreground">Managed PostgreSQL · role <span className="font-mono">{legacy.role_name}</span></p></div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm"><Link href={`/database?database=${encodeURIComponent(legacy.database_name)}`}>Browse data</Link></Button>
              <Button variant="outline" size="sm" disabled={busy || !isAdmin} onClick={() => void legacyAction('rotate_password')}>Rotate password</Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { mode: 'new' as const, icon: <Sparkles className="h-4 w-4" />, title: 'Create a database', text: usableConnections.length ? `New ${providerMeta[(usableConnections.find(c => c.is_default) || usableConnections[0]).provider].label} database (or any other engine) with its own user.` : 'PostgreSQL, MySQL, MongoDB and more. Install one on this server if needed.', disabled: false },
              { mode: 'stack' as const, icon: <Layers className="h-4 w-4" />, title: 'Use a project database', text: available.length ? `Share ${available[0].database_name} from ${available[0].project_name}${available.length > 1 ? ` or ${available.length - 1} more` : ''}.` : 'No other app in this project has a database to share yet.', disabled: !available.length },
              { mode: 'existing' as const, icon: <Link2 className="h-4 w-4" />, title: 'Connect an existing one', text: 'Use a database that already exists, with its own username and password.', disabled: !connections.length },
            ].map(option => (
              <button key={option.mode} type="button" disabled={option.disabled || !isAdmin} onClick={() => openAdd(option.mode)}
                className="flex flex-col items-start gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-white/25 hover:bg-white/[0.02] disabled:cursor-not-allowed disabled:opacity-45">
                <span className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-black">{option.icon}</span>
                <span><span className="block text-sm font-medium">{option.title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.text}</span></span>
              </button>
            ))}
            {!isAdmin && <p className="text-xs text-muted-foreground md:col-span-3">An administrator can add databases.</p>}
          </div>
        )}
      </Section>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Add a database</SheetTitle>
            <SheetDescription>{projectName} · credentials are encrypted and only given to this application</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-6">
            <div className="grid gap-2" role="radiogroup" aria-label="Database source">
              <ChoiceCard selected={mode === 'new'} onSelect={() => openAdd('new')} icon={<Sparkles className="h-4 w-4" />} title="Create a new database" description="Synergy creates the database and a dedicated user for you." />
              <ChoiceCard selected={mode === 'stack'} onSelect={() => openAdd('stack')} disabled={!available.length} icon={<Layers className="h-4 w-4" />} title="Use a database from this project" description={available.length ? 'Your frontend and backend read the same data. The owning app keeps control of its password.' : 'No other app in this project has a database to share yet.'} />
              <ChoiceCard selected={mode === 'existing'} onSelect={() => openAdd('existing')} disabled={!connections.length} icon={<Link2 className="h-4 w-4" />} title="Connect an existing database" description="Verify a database that already exists with its own credentials." />
            </div>

            {mode === 'stack' && (
              <div className="space-y-2" role="radiogroup" aria-label="Project database">
                <p className="text-sm font-medium">Choose a database</p>
                {available.map(item => (
                  <ChoiceCard key={item.id} selected={form.sourceServiceId === item.id} onSelect={() => setForm({ ...form, sourceServiceId: item.id, envPrefix: envName(item.name) })}
                    icon={<ProviderLogo provider={item.provider} size="sm" />} title={<span className="font-mono">{item.database_name}</span>}
                    description={`${providerMeta[item.provider]?.label} · owned by ${item.project_name} (${roleLabels[item.component_role] || item.component_role})`} />
                ))}
              </div>
            )}

            {mode !== 'stack' && (
              <div className="space-y-4">
                {mode === 'new' ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Database engine</p>
                    <ServiceCatalog role={role} selectedConnectionId={form.connectionId} onSelect={server => { setSelectedServer(server); setForm({ ...form, connectionId: server.id }) }} />
                  </div>
                ) : (
                  <label className="field-label">Database server<select className="control-input" value={form.connectionId} onChange={event => setForm({ ...form, connectionId: event.target.value })}>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {providerMeta[connection.provider]?.label}</option>)}</select></label>
                )}
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="field-label">Name<input className="control-input" value={form.name} onChange={event => setForm({ ...form, name: event.target.value, envPrefix: envName(event.target.value) })} /></label>
                  <label className="field-label">{mode === 'existing' ? 'Database name' : <span>Database name <span className="font-normal text-muted-foreground">optional</span></span>}<input className="control-input font-mono" value={form.databaseName} onChange={event => setForm({ ...form, databaseName: event.target.value })} placeholder={mode === 'existing' ? 'existing_database' : 'Generated'} /></label>
                </div>
                {mode === 'new' && selectedConnection?.provider !== 'redis' && <label className="flex items-center justify-between gap-4 text-sm"><span>Choose my own username and password</span><Switch checked={form.customCredentials} onCheckedChange={customCredentials => setForm({ ...form, customCredentials })} /></label>}
                {(mode === 'existing' || form.customCredentials) && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="field-label sm:col-span-2">Username<input className="control-input" autoComplete="off" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} placeholder={mode === 'new' ? 'Generated when blank' : ''} /></label>
                    <label className="field-label">Password<input className="control-input" type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label>
                    <label className="field-label">Confirm password<input className="control-input" type="password" autoComplete="new-password" value={form.confirm} onChange={event => setForm({ ...form, confirm: event.target.value })} /></label>
                    {mode === 'new' && <p className="text-xs text-muted-foreground sm:col-span-2">At least 16 characters.</p>}
                  </div>
                )}
              </div>
            )}

            <div className="divide-y divide-border rounded-lg border border-border">
              <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Main application database</span><span className="block text-xs text-muted-foreground">Provides the framework&apos;s standard variables, like DATABASE_URL.</span></span><Switch checked={form.applicationPrimary} onCheckedChange={applicationPrimary => setForm({ ...form, applicationPrimary })} /></label>
              {mode === 'new' && selectedConnection?.provider === 'postgresql' && <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Daily backups</span><span className="block text-xs text-muted-foreground">Kept for 30 days. Change the schedule in Data Services.</span></span><Switch checked={form.backup} onCheckedChange={backup => setForm({ ...form, backup })} /></label>}
              <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Write variables to .env now</span><span className="block text-xs text-muted-foreground">Otherwise they are added at the next deployment.</span></span><Switch checked={form.syncEnv} onCheckedChange={syncEnv => setForm({ ...form, syncEnv })} /></label>
              <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span className="font-medium">Variable prefix</span><input className="control-input h-8 w-40 font-mono text-xs" value={form.envPrefix} onChange={event => setForm({ ...form, envPrefix: event.target.value.toUpperCase().replace(/[^A-Z0-9_]+/g, '') })} aria-label="Variable prefix" /></label>
            </div>

            {notice?.tone === 'error' && <p role="alert" className="rounded-md border border-red-400/25 bg-red-400/5 px-3 py-2 text-sm text-red-300">{notice.text}</p>}
            <Button className="w-full" onClick={() => void create()} disabled={busy || !canSubmit}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
              {mode === 'stack' ? 'Connect project database' : mode === 'existing' ? 'Verify and connect' : 'Create database'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={passwordFor !== null} onOpenChange={next => { if (!next) setPasswordFor(null) }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Change database password</SheetTitle><SheetDescription>{passwordFor?.database_name} · {passwordFor?.username}</SheetDescription></SheetHeader>
          <div className="mt-6 grid gap-4">
            <label className="field-label">New password<input className="control-input" type="password" autoComplete="new-password" value={password.value} onChange={event => setPassword({ ...password, value: event.target.value })} /></label>
            <label className="field-label">Confirm password<input className="control-input" type="password" autoComplete="new-password" value={password.confirm} onChange={event => setPassword({ ...password, confirm: event.target.value })} /></label>
            <p className="text-xs text-muted-foreground">At least 16 characters. Synergy verifies it against the database{passwordFor?.shared_with?.length ? ` and updates ${passwordFor.shared_with.join(', ')} too` : ''}.</p>
            {notice?.tone === 'error' && <p role="alert" className="text-sm text-red-300">{notice.text}</p>}
            <Button onClick={() => void rotate()} disabled={busy || password.value.length < 16 || password.value !== password.confirm}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}Change password</Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
