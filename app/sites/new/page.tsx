'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, ArrowRight, ChevronDown, Database, GitBranch, Globe2, Layers, Link2, Loader2, LockKeyhole, Search, Server, AppWindow } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { ChoiceCard, roleLabels } from '@/components/app/section'
import { RolePicker } from '@/components/app/stack-panel'
import { FrameworkLogo } from '@/components/synergy/framework-logo'
import { cn } from '@/lib/utils'

interface Repo { id: number; name: string; fullName: string; avatarUrl: string; private: boolean; defaultBranch: string; cloneUrl: string; registered: boolean }
interface Connection { id: string; name: string; account_login: string }
interface Application { id: string; name: string; project_type: string; environment: string; application_group_name?: string | null; component_role?: string }

const GitHubIcon = ({ className = 'h-4 w-4' }: { className?: string }) => <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
const repoFromUrl = (url: string) => url.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')

export default function NewSitePage() {
  const router = useRouter()
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [repos, setRepos] = useState<Repo[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [role, setRole] = useState('viewer')
  const [urlInput, setUrlInput] = useState('')
  const [configuring, setConfiguring] = useState<{ fullName: string; avatarUrl?: string; private?: boolean } | null>(null)
  const [applications, setApplications] = useState<Application[]>([])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main', rootPath: '', staging: 'no', stagingBranch: 'staging', stack: 'standalone', relatedProjectId: '', componentRole: 'frontend' })

  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([fetch('/api/auth/me', { signal: abort.signal }), fetch('/api/github/connections', { signal: abort.signal }), fetch('/api/sites', { signal: abort.signal })]).then(async ([me, res, sites]) => {
      if (!me.ok || !res.ok || !sites.ok) throw new Error('Could not load account connections and applications')
      setApplications((await sites.json()).filter((app: Application) => app.environment === 'production'))
      setRole((await me.json()).user?.role || 'viewer')
      const values = (await res.json()).connections || []
      setConnections(values); setConnectionId(values[0]?.id || '')
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!connectionId) { setRepos([]); return }
    const abort = new AbortController()
    setLoading(true); setError(''); setRepos([])
    void fetch('/api/github/repos?connectionId=' + encodeURIComponent(connectionId), { signal: abort.signal }).then(async res => {
      const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Could not load repositories'); setRepos(body.repos || [])
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [connectionId])

  const visible = useMemo(() => repos.filter(repo => repo.fullName.toLowerCase().includes(search.toLowerCase())), [repos, search])
  const stacks = useMemo(() => {
    const grouped = new Map<string, Application[]>()
    for (const app of applications) {
      const key = app.application_group_name || ''
      if (key) grouped.set(key, [...(grouped.get(key) || []), app])
    }
    return grouped
  }, [applications])

  const importRepo = (repo: Repo) => {
    setConfiguring({ fullName: repo.fullName, avatarUrl: repo.avatarUrl, private: repo.private })
    setForm(current => ({ ...current, name: repo.name, repoUrl: repo.cloneUrl, branch: repo.defaultBranch }))
    setError('')
    window.scrollTo({ top: 0 })
  }
  const importUrl = () => {
    const fullName = repoFromUrl(urlInput)
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) { setError('Enter a GitHub repository URL like https://github.com/org/repo'); return }
    setConfiguring({ fullName })
    setForm(current => ({ ...current, name: fullName.split('/')[1], repoUrl: `https://github.com/${fullName}`, branch: 'main' }))
    setError('')
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setCreating(true); setError('')
    try {
      const joining = form.stack === 'join' && form.relatedProjectId
      const response = await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: form.name.trim(), repoUrl: form.repoUrl.trim(), defaultBranch: form.branch.trim(), rootPath: form.rootPath.trim() || null, projectType: 'next',
        githubConnectionId: connectionId || null, createStaging: form.staging === 'yes', stagingBranch: form.stagingBranch.trim(),
        relatedProjectId: joining ? form.relatedProjectId : null, componentRole: joining ? form.componentRole : 'application', setupDraft: true, autoDeploy: false,
      }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not create application')
      router.push('/sites/' + body.id + '?tab=setup&new=1')
    } catch (err) { setError((err as Error).message); setCreating(false) }
  }

  const relatedApp = applications.find(app => app.id === form.relatedProjectId)

  if (configuring) {
    return (
      <AppShell title="Configure your application" subtitle="A few details, then Synergy clones, detects and sets it up." back={{ href: '/sites', label: 'Applications' }}>
        <div className="mx-auto max-w-3xl">
          <button type="button" onClick={() => setConfiguring(null)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Choose a different repository</button>
          <form onSubmit={create} className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-black px-6 py-5">
              {configuring.avatarUrl ? <Image src={configuring.avatarUrl} alt="" width={36} height={36} unoptimized className="h-9 w-9 rounded-full" /> : <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border"><GitHubIcon /></span>}
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Importing from GitHub</p>
                <p className="flex items-center gap-1.5 truncate font-medium">{configuring.fullName}{configuring.private && <LockKeyhole className="h-3.5 w-3.5 text-muted-foreground" aria-label="Private repository" />}</p>
              </div>
              <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-xs"><GitBranch className="h-3.5 w-3.5" />{form.branch || 'main'}</span>
            </div>

            <div className="space-y-8 p-6">
              {error && <div role="alert" className="notice-error">{error}</div>}
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="field-label">Application name<input required maxLength={100} className="control-input" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
                <label className="field-label">Production branch<div className="relative"><GitBranch className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input required className="control-input pl-9 font-mono" value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} /></div></label>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-3 text-sm font-medium">Environments</legend>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Environments">
                  <ChoiceCard selected={form.staging === 'no'} onSelect={() => setForm({ ...form, staging: 'no' })} title="Production" description={`Pushes to ${form.branch || 'main'} go live.`} />
                  <ChoiceCard selected={form.staging === 'yes'} onSelect={() => setForm({ ...form, staging: 'yes' })} title="Production + Staging" description="Test on a separate copy, then promote to production." />
                </div>
                {form.staging === 'yes' && <label className="field-label max-w-xs">Staging branch<input required className="control-input font-mono" value={form.stagingBranch} onChange={event => setForm({ ...form, stagingBranch: event.target.value })} /></label>}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="mb-1 text-sm font-medium">Stack</legend>
                <p className="text-xs text-muted-foreground">Deploying a frontend and its backend separately? Put them in one stack so they can share a database and one domain.</p>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Stack">
                  <ChoiceCard selected={form.stack === 'standalone'} onSelect={() => setForm({ ...form, stack: 'standalone' })} icon={<AppWindow className="h-4 w-4" />} title="Standalone app" description="Everything lives in this one repository." />
                  <ChoiceCard selected={form.stack === 'join'} disabled={!applications.length} onSelect={() => {
                    const relatedProjectId = form.relatedProjectId || applications[0]?.id || ''
                    const partnerRole = applications.find(app => app.id === relatedProjectId)?.component_role
                    setForm({ ...form, stack: 'join', relatedProjectId, componentRole: partnerRole === 'frontend' ? 'backend' : partnerRole === 'backend' ? 'frontend' : form.componentRole })
                  }} icon={<Layers className="h-4 w-4" />} title="Part of a stack" description={applications.length ? 'Connect it with an existing frontend, backend or service.' : 'Import the first app of the stack, then come back.'} />
                </div>
                {form.stack === 'join' && (
                  <div className="space-y-4 rounded-lg border border-border p-4">
                    <label className="field-label">Connect with<select className="control-input" value={form.relatedProjectId} onChange={event => {
                      const app = applications.find(item => item.id === event.target.value)
                      setForm({ ...form, relatedProjectId: event.target.value, componentRole: app?.component_role === 'frontend' ? 'backend' : app?.component_role === 'backend' ? 'frontend' : form.componentRole })
                    }}>
                      {[...stacks.entries()].map(([name, apps]) => <optgroup key={name} label={`${name} stack`}>{apps.map(app => <option key={app.id} value={app.id}>{app.name} · {roleLabels[app.component_role || 'application']}</option>)}</optgroup>)}
                      <optgroup label="Not in a stack yet">{applications.filter(app => !app.application_group_name).map(app => <option key={app.id} value={app.id}>{app.name}</option>)}</optgroup>
                    </select></label>
                    <div className="space-y-2"><p className="text-sm font-medium">This app is the…</p><RolePicker value={form.componentRole} onChange={componentRole => setForm({ ...form, componentRole })} /></div>
                    {relatedApp && (
                      <div className="flex flex-wrap items-center gap-2 rounded-md bg-white/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5 text-foreground"><FrameworkLogo type="next" className="h-3.5 w-3.5" />{form.name || 'This app'}</span><span>({roleLabels[form.componentRole]})</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                        <span className="flex items-center gap-1.5 text-foreground"><FrameworkLogo type={relatedApp.project_type} className="h-3.5 w-3.5" />{relatedApp.name}</span>
                        <span className="ml-auto flex items-center gap-3"><span className="flex items-center gap-1"><Database className="h-3 w-3" />can share DB</span><span className="flex items-center gap-1"><Globe2 className="h-3 w-3" />can share domain</span></span>
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              <div className="overflow-hidden rounded-lg border border-border">
                <button type="button" onClick={() => setShowAdvanced(value => !value)} aria-expanded={showAdvanced} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-white/[0.02]"><ChevronDown className={cn('h-4 w-4 transition-transform', !showAdvanced && '-rotate-90')} />Advanced<span className="ml-auto text-xs font-normal text-muted-foreground">Install directory</span></button>
                {showAdvanced && <div className="border-t border-border p-4"><label className="field-label">Install directory on this server<input className="control-input font-mono" value={form.rootPath} onChange={event => setForm({ ...form, rootPath: event.target.value })} placeholder="Chosen automatically" /></label></div>}
              </div>

              <div className="grid gap-3 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground sm:grid-cols-3">
                <p><span className="block font-medium text-foreground">Framework</span>Detected after cloning</p>
                <p><span className="block font-medium text-foreground">Port</span>Assigned automatically</p>
                <p><span className="block font-medium text-foreground">Auto-deploy</span>Off until the first release</p>
              </div>
            </div>

            <div className="border-t border-border bg-white/[0.015] px-6 py-4">
              <Button type="submit" className="h-10 w-full" disabled={creating || role === 'viewer' || !form.name.trim() || !form.repoUrl.trim() || (form.stack === 'join' && !form.relatedProjectId)}>
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{creating ? 'Creating…' : <>Continue to setup<ArrowRight className="ml-2 h-4 w-4" /></>}
              </Button>
              {role === 'viewer' && <p className="mt-2 text-center text-xs text-muted-foreground">Viewers can&apos;t create applications.</p>}
            </div>
          </form>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell title="Let's ship something new" subtitle="Import a Git repository. Synergy builds it, checks its health and serves it from this server." back={{ href: '/sites', label: 'Applications' }}>
      {error && <div role="alert" className="notice-error">{error}</div>}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Import Git repository">
          <div className="border-b border-border p-5">
            <h2 className="text-lg font-semibold tracking-tight">Import Git Repository</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              <div className="relative min-w-[180px]">
                <GitHubIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4" />
                <select aria-label="GitHub account" className="control-input pl-9" value={connectionId} onChange={event => setConnectionId(event.target.value)}>
                  {!connections.length && <option value="">No GitHub account</option>}
                  {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.account_login}</option>)}
                </select>
              </div>
              <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input aria-label="Search repositories" className="control-input pl-9" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search…" /></div>
            </div>
          </div>
          <div className="max-h-[480px] min-h-48 overflow-y-auto" aria-busy={loading}>
            {loading ? <div className="divide-y divide-border">{[0, 1, 2, 3, 4].map(i => <div key={i} className="flex items-center gap-3 px-5 py-4"><div className="h-8 w-8 animate-pulse rounded-full bg-white/[0.05]" /><div className="h-3 w-48 animate-pulse rounded bg-white/[0.05]" /></div>)}</div>
              : !connections.length ? (
                <div className="px-6 py-14 text-center">
                  <GitHubIcon className="mx-auto mb-3 h-6 w-6" />
                  <p className="text-sm font-medium">Connect GitHub to see your repositories</p>
                  <p className="mt-1 text-xs text-muted-foreground">Or paste a public repository URL on the right.</p>
                  <Button asChild size="sm" variant="outline" className="mt-4"><Link href="/settings?section=github">Connect GitHub</Link></Button>
                </div>
              ) : !visible.length ? <p className="py-14 text-center text-sm text-muted-foreground">No repositories match “{search}”.</p>
              : <div className="divide-y divide-border">{visible.map(repo => (
                <div key={repo.id} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]">
                  {repo.avatarUrl ? <Image src={repo.avatarUrl} alt="" width={32} height={32} unoptimized className="h-8 w-8 shrink-0 rounded-full" /> : <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border"><GitHubIcon /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">{repo.name}{repo.private && <LockKeyhole className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}</p>
                    <p className="truncate text-xs text-muted-foreground">{repo.fullName}{repo.registered ? ' · already imported' : ''}</p>
                  </div>
                  <Button size="sm" variant={repo.registered ? 'outline' : 'default'} onClick={() => importRepo(repo)} disabled={role === 'viewer'}>Import</Button>
                </div>
              ))}</div>}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4" />Import from a URL</h2>
            <p className="mt-1 text-xs text-muted-foreground">Any public GitHub repository, or a private one your connected account can read.</p>
            <form className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); importUrl() }}>
              <input aria-label="Repository URL" className="control-input font-mono text-xs" value={urlInput} onChange={event => setUrlInput(event.target.value)} placeholder="https://github.com/org/repo" />
              <Button type="submit" variant="outline" disabled={!urlInput.trim() || role === 'viewer'}>Continue</Button>
            </form>
          </section>
          <section className="relative overflow-hidden rounded-xl border border-border bg-black p-5">
            <div className="syn-canvas pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
            <div className="relative">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Layers className="h-4 w-4 text-syn-violet" />Frontend + backend? Use a stack</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Import each repository and mark it as part of the same stack. Stack apps can share one database and one domain, for example <span className="font-mono text-foreground">app.example.com</span> for the frontend and <span className="font-mono text-foreground">app.example.com/api</span> for the backend.</p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"><AppWindow className="h-3.5 w-3.5" />Frontend</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"><Server className="h-3.5 w-3.5" />Backend API</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1"><Database className="h-3.5 w-3.5" />Database</span>
              </div>
            </div>
          </section>
          <section className="rounded-xl border border-border bg-card p-5 text-xs text-muted-foreground">
            <p className="mb-3 text-sm font-semibold text-foreground">What happens next</p>
            <ol className="space-y-2.5">
              {['Synergy clones the repository and detects the framework', 'You choose a database, environment variables and a domain', 'The app is built, health-checked, then switched live with no downtime'].map((text, index) => (
                <li key={text} className="flex gap-2.5"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-foreground">{index + 1}</span>{text}</li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </AppShell>
  )
}
