'use client'

import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowUpRight, Bell, Check, Database, Eye, EyeOff, Folder, Github, Globe2, HardDrive, Loader2, LockKeyhole, RefreshCw, Save, Search, Send, Server, Undo2, Users } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { RuntimeManager } from '@/components/runtime-manager'
import { GitHubConnections } from '@/components/settings/github-connections'
import { EDITABLE_SETTINGS, SETTINGS_SECTIONS, SECTION_FIELDS, settingsChanges, settingsForm, settingsSection, validateSettingsSection, type SettingsField, type SettingsForm, type SettingsSection } from '@/lib/settings-workspace'

interface SessionUser { id: string; email: string; name: string; role: 'admin' | 'operator' | 'viewer' }
interface UserRow { id: string; email: string; name: string; role: string; status: string; created_at: string; last_login_at: string | null }
type Notice = { kind: 'success' | 'error'; text: string }
const icons = { general: Folder, runtimes: Server, integrations: Github, notifications: Bell, backups: HardDrive, access: Users }
const roleNames: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' }

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="grid min-w-0 items-start gap-3 border-b border-border py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] sm:gap-6">
    <div><p className="text-sm font-medium">{label}</p>{hint && <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>}</div>
    <div className="min-w-0">{children}</div>
  </div>
}

function ManagementLink({ href, label, detail, icon: Icon }: { href: string; label: string; detail: string; icon: typeof Database }) {
  return <Link href={href} className="group flex min-w-0 items-center gap-3 border-b border-border py-4">
    <Icon className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
    <div className="min-w-0 flex-1"><p className="text-sm font-medium group-hover:text-primary">{label}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>
    <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  </Link>
}

function AccountAccess({ user }: { user: SessionUser | null }) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const load = useCallback(async () => {
    if (user?.role !== 'admin') { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/users')
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to load Manager users')
      if (!Array.isArray(body)) throw new Error('Invalid users response')
      setUsers(body)
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to load Manager users') }
    finally { setLoading(false) }
  }, [user?.role])
  useEffect(() => { void load() }, [load])
  const shown = users.filter(item => `${item.name} ${item.email} ${item.role}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="space-y-8">
    <div><h3 className="mb-3 text-sm font-semibold">Your account</h3><dl className="summary-list">
      <div><dt>Name</dt><dd className="break-words">{user?.name || '-'}</dd></div>
      <div><dt>Email</dt><dd className="break-all">{user?.email || '-'}</dd></div>
      <div><dt>Access</dt><dd><Badge variant="outline">{roleNames[user?.role || ''] || '-'}</Badge></dd></div>
    </dl></div>
    {user?.role === 'admin' && <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Manager users <span className="ml-1 font-normal text-muted-foreground">{users.length}</span></h3><Button variant="ghost" size="icon" title="Refresh users" aria-label="Refresh users" disabled={loading} onClick={() => void load()}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button></div>
      <div className="relative mb-4 max-w-sm"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search users" className="control-input pl-9" placeholder="Search name, email, or role" value={search} onChange={event => setSearch(event.target.value)} /></div>
      {error && <p role="alert" className="notice-error">{error}</p>}
      {loading ? <p role="status" className="py-8 text-sm text-muted-foreground">Loading users...</p> : <div className="divide-y divide-border border-y border-border">
        {shown.map(item => <div key={item.id} className="grid min-w-0 gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}{item.id === user.id && <span className="ml-2 text-xs font-normal text-muted-foreground">You</span>}</p><p className="mt-1 break-all text-xs text-muted-foreground">{item.email}</p></div>
          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{roleNames[item.role] || item.role}</Badge><span className={`text-xs capitalize ${item.status === 'active' ? 'text-emerald-400' : 'text-muted-foreground'}`}>{item.status}</span></div>
        </div>)}
        {!shown.length && <p className="py-8 text-sm text-muted-foreground">{search ? 'No matching users.' : 'No users found.'}</p>}
      </div>}
    </div>}
  </div>
}

function SettingsWorkspace() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const section = settingsSection(searchParams.get('section'))
  const current = SETTINGS_SECTIONS.find(item => item.id === section)!
  const [visited, setVisited] = useState<SettingsSection[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [saved, setSaved] = useState<SettingsForm>({ ...EDITABLE_SETTINGS })
  const [draft, setDraft] = useState<SettingsForm>({ ...EDITABLE_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState<SettingsSection | null>(null)
  const [notices, setNotices] = useState<Partial<Record<SettingsSection, Notice>>>({})
  const [testing, setTesting] = useState(false)
  const [showWebhook, setShowWebhook] = useState(false)
  const isAdmin = user?.role === 'admin'
  const dirtySections = SETTINGS_SECTIONS.filter(item => Object.keys(settingsChanges(item.id, saved, draft)).length > 0)
  const changed = Object.keys(settingsChanges(section, saved, draft)).length

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const meResponse = await fetch('/api/auth/me')
      const me = await meResponse.json()
      if (!meResponse.ok || !me.user) throw new Error('Sign in to access Manager settings.')
      setUser(me.user)
      const response = await fetch('/api/settings', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to load settings')
      const values = settingsForm(body)
      setSaved(values); setDraft(values); setLoaded(true)
    } catch (error) { setLoadError(error instanceof Error ? error.message : 'Unable to load settings') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setVisited(previous => previous.includes(section) ? previous : [...previous, section]) }, [section])
  useEffect(() => {
    if (!dirtySections.length) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirtySections.length])

  const notify = (target: SettingsSection, notice?: Notice) => setNotices(previous => ({ ...previous, [target]: notice }))
  const edit = (key: SettingsField, value: string) => { setDraft(previous => ({ ...previous, [key]: value })); notify(section) }
  const handleSave = async () => {
    if (!isAdmin || !loaded || saving) return
    const target = section
    const validation = validateSettingsSection(target, draft)
    if (validation) { notify(target, { kind: 'error', text: validation }); return }
    const updates = settingsChanges(target, saved, draft)
    if (!Object.keys(updates).length) return
    setSaving(target); notify(target)
    try {
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to save settings')
      setSaved(previous => ({ ...previous, ...updates }))
      notify(target, { kind: 'success', text: 'Changes saved.' })
    } catch (error) { notify(target, { kind: 'error', text: error instanceof Error ? error.message : 'Unable to save settings' }) }
    finally { setSaving(null) }
  }
  const discard = () => {
    if (!window.confirm(`Discard unsaved ${current.label.toLowerCase()} changes?`)) return
    setDraft(previous => ({ ...previous, ...Object.fromEntries(SECTION_FIELDS[section].map(key => [key, saved[key]])) }))
    notify(section)
  }
  const testNotification = async () => {
    if (!isAdmin || testing || !saved.NOTIFY_WEBHOOK_URL || Object.keys(settingsChanges('notifications', saved, draft)).length) return
    setTesting(true); notify('notifications')
    try {
      const response = await fetch('/api/settings/test-notification', { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to send test notification')
      notify('notifications', { kind: 'success', text: 'Test notification sent.' })
    } catch (error) { notify('notifications', { kind: 'error', text: error instanceof Error ? error.message : 'Unable to send test notification' }) }
    finally { setTesting(false) }
  }
  const input = (key: SettingsField, label: string, placeholder?: string) => <input aria-label={label} className="control-input font-mono text-xs" value={draft[key]} onChange={event => edit(key, event.target.value)} disabled={!isAdmin || !loaded || !!saving} placeholder={placeholder} autoComplete="off" spellCheck={false} />
  const saveControls = isAdmin && <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background py-4">
    <p className={`text-xs ${changed ? 'text-amber-400' : 'text-muted-foreground'}`} role="status">{changed ? `${changed} unsaved change${changed === 1 ? '' : 's'}` : 'No unsaved changes'}</p>
    <div className="flex items-center gap-2"><Button type="button" variant="ghost" size="icon" disabled={!changed || !!saving} onClick={discard} title="Discard section changes" aria-label="Discard section changes"><Undo2 className="h-4 w-4" /></Button><Button type="submit" disabled={!loaded || !!saving || !changed}><span className="mr-2">{saving === section ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}</span>{saving === section ? 'Saving...' : 'Save changes'}</Button></div>
  </footer>
  const formSubmit = (event: FormEvent) => { event.preventDefault(); void handleSave() }

  return <AppShell title="Settings" subtitle="Host configuration and administration" user={user || undefined}>
    <div className="grid min-w-0 gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
      <aside className="min-w-0 lg:border-r lg:border-border lg:pr-5">
        <div className="lg:sticky lg:top-0">
          <label className="field-label lg:hidden">Settings section<select className="control-input" value={section} onChange={event => router.push('/settings?section=' + event.target.value, { scroll: false })}>{SETTINGS_SECTIONS.map(item => <option key={item.id} value={item.id}>{item.label}{dirtySections.some(dirty => dirty.id === item.id) ? ' (unsaved)' : ''}</option>)}</select></label>
          <nav aria-label="Settings sections" className="hidden space-y-1 lg:block">
            {SETTINGS_SECTIONS.map(item => { const Icon = icons[item.id]; const dirty = dirtySections.some(value => value.id === item.id); return <Link key={item.id} href={'/settings?section=' + item.id} scroll={false} aria-current={section === item.id ? 'page' : undefined} className={`flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${section === item.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
              <Icon className={`h-4 w-4 shrink-0 ${section === item.id ? 'text-primary' : ''}`} aria-hidden="true" /><span className="min-w-0 flex-1">{item.label}</span>{dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes"><span className="sr-only">Unsaved changes</span></span>}
            </Link> })}
          </nav>
          <p className="mt-5 hidden border-t border-border pt-4 text-xs text-muted-foreground lg:block">{roleNames[user?.role || ''] || 'Loading account...'}</p>
        </div>
      </aside>
      <section aria-labelledby="settings-section-heading" className="min-w-0">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
          <div className="min-w-0"><h2 id="settings-section-heading" className="text-xl font-semibold">{current.label}</h2><p className="mt-1 text-sm text-muted-foreground">{current.description}</p></div>
          {user && !isAdmin && <Badge variant="outline"><LockKeyhole className="mr-1.5 h-3 w-3" />View only</Badge>}
        </header>
        {loadError && <div role="alert" className="notice-error"><p>{loadError}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />Retry loading</Button></div>}
        {notices[section] && <p role={notices[section]?.kind === 'error' ? 'alert' : 'status'} className={`mb-5 flex items-start gap-2 break-words text-sm ${notices[section]?.kind === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{notices[section]?.kind === 'success' && <Check className="mt-0.5 h-4 w-4 shrink-0" />}{notices[section]?.text}</p>}
        {loading && !loaded ? <div role="status" className="flex items-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading settings...</div> : <>
          {section === 'general' && <form onSubmit={formSubmit}>
            <FieldRow label="Production directory" hint="New production application checkouts.">{input('PRODUCTION_PATH', 'Production directory', 'C:\\web\\production')}</FieldRow>
            <FieldRow label="Staging directory" hint="Optional staging application checkouts.">{input('STAGING_PATH', 'Staging directory', 'C:\\web\\staging')}</FieldRow>
            <FieldRow label="Logs directory" hint="Manager deployment logs.">{input('LOGS_PATH', 'Logs directory', 'C:\\web\\logs')}</FieldRow>
            <FieldRow label="Caddy directory" hint="Edge proxy installation.">{input('CADDY_PATH', 'Caddy directory', 'C:\\web')}</FieldRow>
            <div className="mb-6 mt-6"><ManagementLink href="/services" icon={Server} label="Processes & Caddy" detail="Service status and active proxy configuration" /></div>
            {saveControls}
          </form>}
          {(section === 'runtimes' || visited.includes('runtimes')) && <div hidden={section !== 'runtimes'}><RuntimeManager isAdmin={isAdmin} workspace /></div>}
          {(section === 'integrations' || visited.includes('integrations')) && <div hidden={section !== 'integrations'} className="space-y-8">
            <GitHubConnections isAdmin={isAdmin} />
            <div><h3 className="mb-2 text-sm font-semibold">Infrastructure connections</h3><ManagementLink href="/domains" icon={Globe2} label="Cloudflare & domains" detail="Scoped API tokens, DNS zones, and SSL" /><ManagementLink href="/data-services" icon={Database} label="Database connections" detail="PostgreSQL, MySQL, and other project data providers" /></div>
          </div>}
          {section === 'notifications' && <form onSubmit={formSubmit}>
            <FieldRow label="Deployment webhook" hint="Slack, Discord, or a JSON webhook endpoint."><div className="flex items-center gap-2"><input aria-label="Deployment webhook URL" className="control-input" type={showWebhook ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.NOTIFY_WEBHOOK_URL} onChange={event => edit('NOTIFY_WEBHOOK_URL', event.target.value)} disabled={!isAdmin || !loaded || !!saving} placeholder="https://hooks.example.com/..." /><Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setShowWebhook(value => !value)} title={showWebhook ? 'Hide webhook URL' : 'Show webhook URL'} aria-label={showWebhook ? 'Hide webhook URL' : 'Show webhook URL'}>{showWebhook ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div></FieldRow>
            <div className="flex flex-wrap items-center justify-between gap-4 py-6"><div><p className="text-sm font-medium">Delivery test</p><p className="mt-1 text-xs text-muted-foreground">{changed ? 'Unsaved webhook changes' : saved.NOTIFY_WEBHOOK_URL ? 'Saved endpoint configured' : 'No endpoint configured'}</p></div>{isAdmin && <Button type="button" variant="outline" onClick={() => void testNotification()} disabled={!loaded || testing || !!saving || changed > 0 || !saved.NOTIFY_WEBHOOK_URL} title={changed ? 'Save the webhook before testing' : 'Send a test notification'}>{testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}Send test</Button>}</div>
            {saveControls}
          </form>}
          {section === 'backups' && <form onSubmit={formSubmit}>
            <FieldRow label="Nightly fallback" hint="All PostgreSQL databases; 03:00-05:00 server time when no individual database schedules exist."><div className="flex items-center justify-between gap-4"><label htmlFor="nightly-backups" className="text-sm">Automatic backups</label><Switch id="nightly-backups" checked={draft.BACKUP_ENABLED === 'true'} onCheckedChange={checked => edit('BACKUP_ENABLED', checked ? 'true' : 'false')} disabled={!isAdmin || !loaded || !!saving} /></div></FieldRow>
            <FieldRow label="Backup directory" hint="PostgreSQL backup destination.">{input('BACKUP_DIR', 'Backup directory', 'C:\\web\\backups\\postgres')}</FieldRow>
            <FieldRow label="Retention" hint="Backup files kept before cleanup."><div className="flex items-center gap-3"><input aria-label="Backup retention days" type="number" min={1} max={3650} step={1} required className="control-input max-w-28" value={draft.BACKUP_RETENTION_DAYS} onChange={event => edit('BACKUP_RETENTION_DAYS', event.target.value)} disabled={!isAdmin || !loaded || !!saving} /><span className="text-sm text-muted-foreground">days</span></div></FieldRow>
            <FieldRow label="PostgreSQL tools" hint="Directory containing pg_dump and pg_restore.">{input('PG_BIN_PATH', 'PostgreSQL tools directory')}</FieldRow>
            <div className="mb-6 mt-6"><ManagementLink href="/database" icon={HardDrive} label="PostgreSQL backup schedules" detail="Individual database schedules and restore points" /><ManagementLink href="/sites" icon={Database} label="Application databases" detail="Project data services and provider-specific backups" /></div>
            {saveControls}
          </form>}
          {(section === 'access' || visited.includes('access')) && <div hidden={section !== 'access'}><AccountAccess user={user} /></div>}
        </>}
      </section>
    </div>
  </AppShell>
}

export default function SettingsPage() {
  return <Suspense fallback={<AppShell title="Settings"><p role="status" className="text-sm text-muted-foreground">Loading settings...</p></AppShell>}><SettingsWorkspace /></Suspense>
}
