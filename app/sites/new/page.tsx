'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, ArrowRight, GitBranch, Github, LockKeyhole, Search, Loader2, Check } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { SetupSteps } from '@/components/setup-steps'

interface Repo { id: number; name: string; fullName: string; avatarUrl: string; private: boolean; defaultBranch: string; cloneUrl: string; registered: boolean }
interface Connection { id: string; name: string; account_login: string }
const input = 'control-input'

export default function NewSitePage() {
  const router = useRouter()
  const [connections, setConnections] = useState<Connection[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [repos, setRepos] = useState<Repo[]>([])
  const [selected, setSelected] = useState<Repo | null>(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [role, setRole] = useState('viewer')
  const [manual, setManual] = useState(false)
  const [applications, setApplications] = useState<{ id: string; name: string; project_type: string; environment: string; application_group_name?: string }[]>([])
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main', rootPath: '', staging: '', stagingBranch: 'staging', relatedProjectId: '', componentRole: 'application' })
  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([fetch('/api/auth/me', { signal: abort.signal }), fetch('/api/github/connections', { signal: abort.signal }), fetch('/api/sites', { signal: abort.signal })]).then(async ([me, res, sites]) => {
      if (!me.ok || !res.ok || !sites.ok) throw new Error('Could not load account connections and applications')
      setApplications((await sites.json()).filter((app: { environment: string }) => app.environment === 'production'))
      setRole((await me.json()).user?.role || 'viewer')
      const values = (await res.json()).connections || []
      setConnections(values); setConnectionId(values[0]?.id || ''); setManual(!values.length)
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) })
    return () => abort.abort()
  }, [])
  useEffect(() => {
    if (!connectionId) { setRepos([]); return }
    const abort = new AbortController()
    setLoading(true); setError(''); setSelected(null); setRepos([])
    setForm(current => ({ ...current, name: '', repoUrl: '', branch: 'main' }))
    void fetch('/api/github/repos?connectionId=' + encodeURIComponent(connectionId), { signal: abort.signal }).then(async res => {
      const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Could not load repositories'); setRepos(body.repos || [])
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [connectionId])
  const visible = useMemo(() => repos.filter(repo => repo.fullName.toLowerCase().includes(search.toLowerCase())), [repos, search])
  const select = (repo: Repo) => { setSelected(repo); setForm(current => ({ ...current, name: repo.name, repoUrl: repo.cloneUrl, branch: repo.defaultBranch })) }
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setCreating(true); setError('')
    try {
      if (!form.staging) throw new Error('Choose the environments for this application')
      const response = await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.name.trim(), repoUrl: form.repoUrl.trim(), defaultBranch: form.branch.trim(), rootPath: form.rootPath.trim() || null, projectType: 'next', githubConnectionId: connectionId || null, createStaging: form.staging === 'yes', stagingBranch: form.stagingBranch.trim(), relatedProjectId: form.relatedProjectId || null, componentRole: form.componentRole, setupDraft: true, autoDeploy: false }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not create application')
      router.push('/sites/' + body.id + '?tab=setup')
    } catch (err) { setError((err as Error).message); setCreating(false) }
  }
  return <AppShell title="New application" subtitle="Production / Setup" actions={<Link href="/sites" className="text-sm text-muted-foreground flex items-center gap-2"><ArrowLeft className="h-4 w-4" />Applications</Link>}>
    <div className="setup-layout">
      <SetupSteps step="repository" />
      <div className="min-w-0">
        <div className="section-heading"><div><p className="eyebrow">APPLICATION SETUP</p><h2 className="text-xl font-semibold">Connect a repository</h2></div><Github className="h-6 w-6 text-muted-foreground" /></div>
        {error && <div role="alert" className="notice-error">{error}</div>}
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
          <section className="min-w-0 space-y-4" aria-label="Repository selection">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Source</h3><Link href="/settings" className="text-xs text-primary">Manage connections</Link></div>
            <label className="field-label">GitHub account<select className={input} value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">Public repository</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} / {connection.account_login}</option>)}</select></label>
            <div className="flex border-b border-border" role="tablist" aria-label="Repository source">
              <button type="button" role="tab" aria-selected={!manual} className={'inline-tab ' + (!manual ? 'inline-tab-active' : '')} onClick={() => setManual(false)}>Repositories</button>
              <button type="button" role="tab" aria-selected={manual} className={'inline-tab ' + (manual ? 'inline-tab-active' : '')} onClick={() => { setManual(true); setSelected(null) }}>Repository URL</button>
            </div>
            {manual ? <label className="field-label">GitHub HTTPS URL<input className={input} value={form.repoUrl} onChange={event => setForm({ ...form, repoUrl: event.target.value })} placeholder="https://github.com/organization/repository" /></label> : <>
              <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search repositories" className={input + ' pl-9'} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search repositories" /></div>
              <div className="max-h-[440px] min-h-40 overflow-y-auto divide-y divide-border border-y border-border" aria-busy={loading}>
                {loading ? <div className="flex justify-center py-14"><Loader2 aria-label="Loading repositories" className="h-5 w-5 animate-spin" /></div> : !visible.length ? <p className="py-10 text-sm text-muted-foreground text-center">{connectionId ? 'No matching repositories' : 'No GitHub account selected'}</p> : visible.map(repo => <button type="button" key={repo.id} onClick={() => select(repo)} aria-pressed={selected?.id === repo.id} className={'flex w-full items-center gap-3 p-3 text-left hover:bg-muted ' + (selected?.id === repo.id ? 'bg-primary/10' : '')}>
                  {repo.avatarUrl ? <Image src={repo.avatarUrl} alt="" width={32} height={32} unoptimized className="h-8 w-8 shrink-0 rounded-md" /> : <Github className="h-8 w-8 shrink-0" />}
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{repo.name}</span><span className="block truncate text-xs text-muted-foreground">{repo.fullName}{repo.registered ? ' / Already registered' : ''}</span></span>
                  {repo.private && <LockKeyhole aria-label="Private repository" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}{selected?.id === repo.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>)}
              </div>
            </>}
          </section>
          <form onSubmit={create} className="min-w-0 space-y-5 xl:border-l xl:border-border xl:pl-8">
            <h3 className="text-sm font-semibold">Application details</h3>
            <label className="field-label">Application name<input required maxLength={100} className={input} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="payments-api" /></label>
            <label className="field-label">Deployment branch<div className="relative"><GitBranch className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input required className={input + ' pl-9'} value={form.branch} onChange={event => setForm({ ...form, branch: event.target.value })} /></div></label>
            <dl className="summary-list"><div><dt>Application port</dt><dd>Assigned automatically</dd></div><div><dt>Auto deploy</dt><dd>Off during setup</dd></div><div><dt>Framework</dt><dd>Detect after checkout</dd></div></dl>
            <fieldset className="space-y-3 border-t border-border pt-4"><legend className="text-sm font-semibold">Deployment environments</legend>
              <label className="flex items-center gap-3 text-sm"><input required type="radio" name="staging" value="no" checked={form.staging === 'no'} onChange={() => setForm({ ...form, staging: 'no' })} className="h-4 w-4 accent-emerald-400" />Production only</label>
              <label className="flex items-center gap-3 text-sm"><input required type="radio" name="staging" value="yes" checked={form.staging === 'yes'} onChange={() => setForm({ ...form, staging: 'yes' })} className="h-4 w-4 accent-emerald-400" />Production and staging</label>
              {form.staging === 'yes' && <label className="field-label">Staging branch<input required className={input} value={form.stagingBranch} onChange={event => setForm({ ...form, stagingBranch: event.target.value })} /></label>}
            </fieldset>
            <div className="space-y-4 border-t border-border pt-4">
              <label className="field-label">Component role<select className={input} value={form.componentRole} onChange={event => setForm({ ...form, componentRole: event.target.value })}><option value="application">Application</option><option value="frontend">Frontend</option><option value="backend">Backend API</option><option value="service">Service</option></select></label>
              <label className="field-label">Related application<select className={input} value={form.relatedProjectId} onChange={event => setForm({ ...form, relatedProjectId: event.target.value })}><option value="">Independent application</option>{applications.map(app => <option key={app.id} value={app.id}>{app.name} ({app.project_type}){app.application_group_name ? ' / ' + app.application_group_name : ''}</option>)}</select></label>
            </div>
            <details className="border-t border-border pt-4"><summary className="cursor-pointer text-xs text-muted-foreground">Advanced directory</summary><label className="field-label mt-4">Absolute application directory<input className={input} value={form.rootPath} onChange={event => setForm({ ...form, rootPath: event.target.value })} placeholder="Automatic" /></label></details>
            <div className="border-t border-border pt-5"><Button type="submit" className="w-full" disabled={creating || role === 'viewer' || !form.name.trim() || !form.repoUrl.trim() || !form.staging}>{creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}{creating ? 'Creating application...' : 'Create & continue'}</Button></div>
          </form>
        </div>
      </div>
    </div>
  </AppShell>
}
