'use client'

import { Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowUpRight, Bell, Check, Database, Eye, EyeOff, Folder, Github, Globe2, HardDrive, Loader2, LockKeyhole, LogOut, RefreshCw, Save, Search, Send, Server, Undo2, UserRound, Users, Wrench } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { GitHubConnections } from '@/components/settings/github-connections'
import { EDITABLE_SETTINGS, MOVED_SETTINGS_SECTIONS, SETTINGS_SECTIONS, SECTION_FIELDS, settingsChanges, settingsForm, settingsSection, validateSettingsSection, type SettingsField, type SettingsForm, type SettingsSection } from '@/lib/settings-workspace'

interface SessionUser { id: string; email: string; name: string; role: 'admin' | 'operator' | 'viewer' }
interface UserRow { id: string; email: string; name: string; role: string; status: string; created_at: string; last_login_at: string | null }
type Notice = { kind: 'success' | 'error'; text: string }
const icons = { account: UserRound, access: Users, integrations: Github, notifications: Bell, general: Folder, backups: HardDrive }
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

const roleDescriptions: Record<string, string> = {
  admin: 'Everything, including server settings, databases, domains and the team.',
  operator: 'Deploy apps, change their settings and environment, and run commands.',
  viewer: 'See projects, deployments and logs, without changing anything.',
}

function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setNotice(null)
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not change the password')
      setCurrent(''); setNext(''); setNotice({ kind: 'success', text: 'Password changed. Use it the next time you sign in.' })
    } catch (error) { setNotice({ kind: 'error', text: (error as Error).message }) } finally { setBusy(false) }
  }
  return <form onSubmit={submit} className="space-y-3">
    <h3 className="text-sm font-semibold">Change password</h3>
    <div className="grid max-w-xl gap-3 sm:grid-cols-2">
      <input aria-label="Current password" type="password" autoComplete="current-password" className="control-input" placeholder="Current password" value={current} onChange={event => setCurrent(event.target.value)} required />
      <input aria-label="New password" type="password" autoComplete="new-password" minLength={12} className="control-input" placeholder="New password (12+ characters)" value={next} onChange={event => setNext(event.target.value)} required />
    </div>
    {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${notice.kind === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>{notice.text}</p>}
    <Button type="submit" variant="outline" disabled={busy || !current || next.length < 12}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}Update password</Button>
  </form>
}

function YourAccount({ user }: { user: SessionUser | null }) {
  const router = useRouter()
  return <div className="space-y-8">
    <dl className="summary-list">
      <div><dt>Name</dt><dd className="break-words">{user?.name || '-'}</dd></div>
      <div><dt>Email</dt><dd className="break-all">{user?.email || '-'}</dd></div>
      <div><dt>Role</dt><dd><Badge variant="outline">{roleNames[user?.role || ''] || '-'}</Badge><p className="mt-2 text-xs text-muted-foreground">{roleDescriptions[user?.role || ''] || ''}</p></dd></div>
    </dl>
    <ChangePassword />
    <Button variant="outline" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined); router.push('/login') }}><LogOut className="mr-2 h-4 w-4" />Sign out</Button>
  </div>
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
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', email: '', password: '', role: 'operator' })
  const [saving, setSaving] = useState('')
  const call = async (key: string, url: string, method: string, body: unknown) => {
    setSaving(key); setError('')
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'The change could not be saved')
      await load(); return true
    } catch (caught) { setError((caught as Error).message); return false } finally { setSaving('') }
  }
  const addMember = async (event: FormEvent) => {
    event.preventDefault()
    if (await call('add', '/api/users', 'POST', draft)) { setDraft({ name: '', email: '', password: '', role: 'operator' }); setAdding(false) }
  }
  return <div className="space-y-8">
    <div><h3 className="mb-3 text-sm font-semibold">Roles</h3><dl className="summary-list">{Object.entries(roleDescriptions).map(([key, text]) => <div key={key}><dt>{roleNames[key]}</dt><dd className="text-muted-foreground">{text}</dd></div>)}</dl></div>
    {user?.role !== 'admin' && <p className="text-sm text-muted-foreground">Only administrators can see and manage the team.</p>}
    {user?.role === 'admin' && <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">Manager users <span className="ml-1 font-normal text-muted-foreground">{users.length}</span></h3><div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => setAdding(value => !value)}><Users className="mr-2 h-4 w-4" />Add member</Button><Button variant="ghost" size="icon" title="Refresh users" aria-label="Refresh users" disabled={loading} onClick={() => void load()}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button></div></div>
      {adding && <form onSubmit={addMember} className="mb-5 space-y-3 rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground">Share the password with them privately. They can change it after signing in, under Your account.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <input aria-label="Name" className="control-input" placeholder="Name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} required />
          <input aria-label="Email" type="email" className="control-input" placeholder="Email" value={draft.email} onChange={event => setDraft({ ...draft, email: event.target.value })} required />
          <input aria-label="Temporary password" type="password" autoComplete="new-password" minLength={12} className="control-input" placeholder="Temporary password (12+ characters)" value={draft.password} onChange={event => setDraft({ ...draft, password: event.target.value })} required />
          <select aria-label="Role" className="control-input" value={draft.role} onChange={event => setDraft({ ...draft, role: event.target.value })}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </div>
        <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving === 'add'}>{saving === 'add' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create account</Button><Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button></div>
      </form>}
      <div className="relative mb-4 max-w-sm"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search users" className="control-input pl-9" placeholder="Search name, email, or role" value={search} onChange={event => setSearch(event.target.value)} /></div>
      {error && <p role="alert" className="notice-error">{error}</p>}
      {loading ? <p role="status" className="py-8 text-sm text-muted-foreground">Loading users...</p> : <div className="divide-y divide-border border-y border-border">
        {shown.map(item => <div key={item.id} className="grid min-w-0 gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0"><p className="break-words text-sm font-medium">{item.name}{item.id === user.id && <span className="ml-2 text-xs font-normal text-muted-foreground">You</span>}</p><p className="mt-1 break-all text-xs text-muted-foreground">{item.email}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            {item.id === user.id
              ? <Badge variant="outline">{roleNames[item.role] || item.role}</Badge>
              : <select aria-label={`Role for ${item.name}`} className="control-input h-8 py-0 text-xs" value={item.role} disabled={!!saving} onChange={event => void call(item.id, `/api/users/${item.id}`, 'PATCH', { role: event.target.value })}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
            <span className={`text-xs capitalize ${item.status === 'active' ? 'text-emerald-400' : 'text-muted-foreground'}`}>{item.status}</span>
            {item.id !== user.id && <Button variant="ghost" size="sm" disabled={!!saving} onClick={() => void call(item.id, `/api/users/${item.id}`, 'PATCH', { status: item.status === 'active' ? 'disabled' : 'active' })}>{item.status === 'active' ? 'Disable' : 'Enable'}</Button>}
          </div>
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
  const moved = MOVED_SETTINGS_SECTIONS[searchParams.get('section') || '']
  useEffect(() => { if (moved) router.replace(moved) }, [moved, router])
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

  return <AppShell title="Settings" subtitle="Your account, your team, connected services and server defaults." user={user || undefined}>
    <div className="grid min-w-0 gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
      <aside className="min-w-0 lg:border-r lg:border-border lg:pr-5">
        <div className="lg:sticky lg:top-0">
          <label className="field-label lg:hidden">Settings section<select className="control-input" value={section} onChange={event => router.push('/settings?section=' + event.target.value, { scroll: false })}>{SETTINGS_SECTIONS.map(item => <option key={item.id} value={item.id}>{item.label}{dirtySections.some(dirty => dirty.id === item.id) ? ' (unsaved)' : ''}</option>)}</select></label>
          <nav aria-label="Settings sections" className="hidden space-y-5 lg:block">
            {(['Personal', 'Workspace', 'Server'] as const).map(group => <div key={group}>
              <p className="mb-1.5 px-3 text-[11px] font-medium text-muted-foreground/80">{group}</p>
              <div className="space-y-0.5">{SETTINGS_SECTIONS.filter(item => item.group === group).map(item => { const Icon = icons[item.id]; const dirty = dirtySections.some(value => value.id === item.id); return <Link key={item.id} href={'/settings?section=' + item.id} scroll={false} aria-current={section === item.id ? 'page' : undefined} className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${section === item.id ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'}`}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1">{item.label}</span>{dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes"><span className="sr-only">Unsaved changes</span></span>}
              </Link> })}</div>
            </div>)}
            <Link href="/infrastructure/runtimes" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"><Wrench className="h-4 w-4" />Runtimes & tools<ArrowUpRight className="ml-auto h-3.5 w-3.5" /></Link>
          </nav>
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
            <p className="mb-2 rounded-lg border border-border bg-white/[0.02] p-3 text-xs leading-5 text-muted-foreground">These folders are used when you add a new app. Apps that already exist stay where they are, so changing a folder never moves or breaks a running app.</p>
            <FieldRow label="Production apps" hint="Where the code of each new production app is stored.">{input('PRODUCTION_PATH', 'Production directory', 'C:\\web\\production')}</FieldRow>
            <FieldRow label="Staging apps" hint="Where the code of each new staging app is stored.">{input('STAGING_PATH', 'Staging directory', 'C:\\web\\staging')}</FieldRow>
            <div className="mb-6 mt-6"><ManagementLink href="/services" icon={Server} label="Processes and the web server" detail="Running apps and Caddy, in Infrastructure" /></div>
            {saveControls}
          </form>}
          {section === 'account' && <YourAccount user={user} />}
          {(section === 'integrations' || visited.includes('integrations')) && <div hidden={section !== 'integrations'} className="space-y-8">
            <GitHubConnections isAdmin={isAdmin} />
            <div><h3 className="mb-2 text-sm font-semibold">Other connected services</h3><ManagementLink href="/domains" icon={Globe2} label="Cloudflare" detail="Accounts Synergy uses to create DNS records, in Infrastructure > Domains & DNS" /><ManagementLink href="/data-services" icon={Database} label="Database servers" detail="Engines apps get their databases from, in Infrastructure > Database servers" /></div>
          </div>}
          {section === 'notifications' && <form onSubmit={formSubmit}>
            <FieldRow label="Deployment webhook" hint="Slack, Discord, or a JSON webhook endpoint."><div className="flex items-center gap-2"><input aria-label="Deployment webhook URL" className="control-input" type={showWebhook ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.NOTIFY_WEBHOOK_URL} onChange={event => edit('NOTIFY_WEBHOOK_URL', event.target.value)} disabled={!isAdmin || !loaded || !!saving} placeholder="https://hooks.example.com/..." /><Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={() => setShowWebhook(value => !value)} title={showWebhook ? 'Hide webhook URL' : 'Show webhook URL'} aria-label={showWebhook ? 'Hide webhook URL' : 'Show webhook URL'}>{showWebhook ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div></FieldRow>
            <div className="flex flex-wrap items-center justify-between gap-4 py-6"><div><p className="text-sm font-medium">Delivery test</p><p className="mt-1 text-xs text-muted-foreground">{changed ? 'Unsaved webhook changes' : saved.NOTIFY_WEBHOOK_URL ? 'Saved endpoint configured' : 'No endpoint configured'}</p></div>{isAdmin && <Button type="button" variant="outline" onClick={() => void testNotification()} disabled={!loaded || testing || !!saving || changed > 0 || !saved.NOTIFY_WEBHOOK_URL} title={changed ? 'Save the webhook before testing' : 'Send a test notification'}>{testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}Send test</Button>}</div>
            {saveControls}
          </form>}
          {section === 'backups' && <form onSubmit={formSubmit}>
            <FieldRow label="Nightly fallback" hint="Backs up every PostgreSQL database between 03:00 and 05:00 server time, for databases with no schedule of their own."><div className="flex items-center justify-between gap-4"><label htmlFor="nightly-backups" className="text-sm">Automatic backups</label><Switch id="nightly-backups" checked={draft.BACKUP_ENABLED === 'true'} onCheckedChange={checked => edit('BACKUP_ENABLED', checked ? 'true' : 'false')} disabled={!isAdmin || !loaded || !!saving} /></div></FieldRow>
            <FieldRow label="Backup directory" hint="PostgreSQL backup destination.">{input('BACKUP_DIR', 'Backup directory', 'C:\\web\\backups\\postgres')}</FieldRow>
            <FieldRow label="Retention" hint="Backup files kept before cleanup."><div className="flex items-center gap-3"><input aria-label="Backup retention days" type="number" min={1} max={3650} step={1} required className="control-input max-w-28" value={draft.BACKUP_RETENTION_DAYS} onChange={event => edit('BACKUP_RETENTION_DAYS', event.target.value)} disabled={!isAdmin || !loaded || !!saving} /><span className="text-sm text-muted-foreground">days</span></div></FieldRow>
            <FieldRow label="PostgreSQL tools" hint="Directory containing pg_dump and pg_restore.">{input('PG_BIN_PATH', 'PostgreSQL tools directory')}</FieldRow>
            <div className="mb-6 mt-6"><ManagementLink href="/storage" icon={HardDrive} label="Back up or restore one database" detail="Each database in Storage has its own backups, schedule and restore" /></div>
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
