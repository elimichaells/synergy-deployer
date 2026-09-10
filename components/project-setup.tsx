'use client'

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, XCircle, Download, Loader2, RefreshCw, Rocket, Save, Square } from 'lucide-react'
import { SetupSteps } from '@/components/setup-steps'
import { Button } from '@/components/ui/button'
import { EnvEditor } from '@/components/env-editor'
import { RuntimeManager } from '@/components/runtime-manager'
import { ProjectDomains } from '@/components/project-domains'
import { PROJECT_TYPES, type ProjectType } from '@/lib/project-types'
import { SETUP_STEPS, type SetupStep, type SetupDecisions, type SetupCheck } from '@/lib/project-setup-policy'

interface SetupProject { id: string; name: string; root_path: string; project_type: ProjectType; repo_url: string; default_branch: string; port: number; url: string | null; runtime_versions: Record<string, string>; build_cmd: string | null; start_cmd: string | null; deploy_script: string | null; step: SetupStep | null; completed_at: string | null; decisions: SetupDecisions }
interface Snapshot { project: SetupProject; checkout: boolean; detectedType?: ProjectType; envExists: boolean; inspectionError?: string }
const titles: Record<SetupStep, string> = { repository: 'Prepare the repository', runtime: 'Runtime & build', database: 'Application database', environment: 'Environment variables', domain: 'Domain & TLS', review: 'Review & deploy' }

export function ProjectSetup({ projectId, database, onChanged, onDeploy, deploying }: { projectId: string; database: ReactNode; onChanged: () => void; onDeploy: () => void; deploying: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [step, setStep] = useState<SetupStep>('repository')
  const [decisions, setDecisions] = useState<SetupDecisions>({})
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [log, setLog] = useState('')
  const [checks, setChecks] = useState<SetupCheck[]>([])
  const [ready, setReady] = useState(false)
  const [env, setEnv] = useState('')
  const [envLoaded, setEnvLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [form, setForm] = useState({ type: 'next' as ProjectType, build: '', start: '', script: '', versions: {} as Record<string, string> })
  const [versions, setVersions] = useState<{ id: string; installedVersions: string[] }[]>([])
  const [showDependencies, setShowDependencies] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const initialized = useRef(false)
  const canWrite = role === 'admin' || role === 'operator'
  const endpoint = '/api/sites/' + projectId
  const load = useCallback(async () => {
    const response = await fetch('/api/sites/' + projectId + '/setup', { cache: 'no-store' })
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not load setup')
    setSnapshot(body)
    if (!initialized.current) {
      const requestedStep = new URLSearchParams(window.location.search).get('step')
      initialized.current = true; setStep(SETUP_STEPS.includes(requestedStep as SetupStep) ? requestedStep as SetupStep : body.project.step || 'repository'); setDecisions(body.project.decisions || {})
      setReady(!!body.project.completed_at)
      setForm({ type: body.project.project_type, build: body.project.build_cmd || '', start: body.project.start_cmd || '', script: body.project.deploy_script || '', versions: body.project.runtime_versions || {} })
    }
    return body as Snapshot
  }, [projectId])
  useEffect(() => {
    void load().catch(err => setError(err.message))
    void fetch('/api/auth/me').then(res => res.json()).then(body => setRole(body.user?.role || 'viewer')).catch(() => setError('Could not load permissions'))
    return () => abort.current?.abort()
  }, [load])
  useEffect(() => {
    if (step !== 'runtime') return
    void fetch('/api/system/runtimes?toolchains=true').then(res => res.json()).then(body => setVersions(body.runtimes || [])).catch(() => setError('Could not inspect installed runtimes'))
  }, [step, showDependencies])
  useEffect(() => {
    if (step !== 'environment' || envLoaded) return
    void fetch(endpoint + '/env?file=.env').then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error); setEnv(body.content || ''); setEnvLoaded(true) }).catch(err => setError(err.message))
  }, [step, endpoint, envLoaded])
  const json = async (url: string, body: unknown, method = 'POST') => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Operation failed'); return result
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (err) { if ((err as Error).name !== 'AbortError') setError((err as Error).message) }
    finally { setBusy(false) }
  }
  const progress = async (next: SetupStep) => {
    await json(endpoint + '/setup', { action: 'progress', step: next, decisions })
    setStep(next); setReady(false); setNotice(''); setError('')
  }
  const navigate = (next: SetupStep) => {
    if (canWrite) void run(async () => { if (dirty) await save(); await progress(next) }); else setStep(next)
  }
  const save = async () => {
    if (step === 'runtime') await json(endpoint, { projectType: form.type, buildCmd: form.build.trim() || null, startCmd: form.start.trim() || null, deployScript: form.script.trim() || null, runtimeVersions: form.versions }, 'PATCH')
    if (step === 'environment' && decisions.environment !== 'runtime') {
      if (!envLoaded) throw new Error('Wait for the environment file to load')
      await json(endpoint + '/env', { file: '.env', content: env })
    }
    setDirty(false); setNotice('Saved'); setReady(false); await load(); onChanged()
  }
  const prepare = () => void run(async () => {
    abort.current = new AbortController(); setLog('')
    const response = await fetch(endpoint + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare' }), signal: abort.current.signal })
    if (!response.ok) throw new Error((await response.json()).error)
    const reader = response.body!.getReader(); const decoder = new TextDecoder()
    while (true) { const result = await reader.read(); if (result.done) break; setLog(current => (current + decoder.decode(result.value, { stream: true })).slice(-100000)) }
    const loaded = await load(); if (!loaded.checkout) throw new Error('Repository is not ready. Review preparation output.')
    onChanged()
  })
  const validate = () => void run(async () => {
    await progress('review')
    const result = await json(endpoint + '/setup', { action: 'complete' }); setChecks(result.checks); setReady(result.ready); await load(); onChanged()
  })
  const next = () => void run(async () => {
    if (step === 'repository' && !snapshot?.checkout) throw new Error('Prepare the repository first')
    if (step === 'runtime' || step === 'environment') await save()
    await progress(SETUP_STEPS[Math.min(SETUP_STEPS.indexOf(step) + 1, SETUP_STEPS.length - 1)])
  })
  const update = (changes: Partial<typeof form>) => { setForm(current => ({ ...current, ...changes })); setDirty(true); setReady(false) }
  if (!snapshot) return <div className="py-16 text-center">{error ? <p role="alert" className="text-red-300">{error}</p> : <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading application setup" />}</div>
  const runtimeIds = form.type === 'go' ? ['go'] : form.type === 'laravel' ? ['php', 'node'] : ['node']
  return <div className="setup-layout">
    <SetupSteps step={step} onSelect={navigate} disabled={busy} />
    <section className="min-w-0" aria-label={titles[step]}>
      <div className="section-heading"><div><p className="eyebrow">APPLICATION SETUP / {SETUP_STEPS.indexOf(step) + 1} OF 6</p><h2 className="text-xl font-semibold">{titles[step]}</h2></div><span className="text-xs text-muted-foreground">{snapshot.project.completed_at ? 'Configured' : 'Draft'}</span></div>
      {error && <div role="alert" className="notice-error">{error}</div>}
      {notice && <p role="status" className="mb-4 text-sm text-emerald-300">{notice}</p>}
      {step === 'repository' && <div className="space-y-5"><dl className="summary-list"><div><dt>Repository</dt><dd className="break-all">{snapshot.project.repo_url}</dd></div><div><dt>Branch</dt><dd>{snapshot.project.default_branch}</dd></div><div><dt>Directory</dt><dd className="break-all font-mono">{snapshot.project.root_path}</dd></div><div><dt>Checkout</dt><dd>{snapshot.checkout ? 'Ready' : 'Not prepared'}</dd></div><div><dt>Detected framework</dt><dd>{snapshot.detectedType ? PROJECT_TYPES[snapshot.detectedType].label : 'Not detected'}</dd></div></dl><div className="flex gap-2"><Button disabled={busy || !canWrite} onClick={prepare}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}{snapshot.checkout ? 'Inspect checkout' : 'Prepare repository'}</Button>{busy && <Button variant="outline" size="icon" title="Cancel repository preparation" aria-label="Cancel repository preparation" onClick={() => abort.current?.abort()}><Square className="h-4 w-4" /></Button>}</div>{log && <pre className="terminal-output" aria-live="polite">{log}</pre>}</div>}
      {step === 'runtime' && <div className="space-y-6"><fieldset disabled={!canWrite || busy} className="space-y-5"><label className="field-label">Framework<select className="control-input" value={form.type} onChange={event => update({ type: event.target.value as ProjectType })}>{Object.entries(PROJECT_TYPES).map(([id, definition]) => <option key={id} value={id}>{definition.label}</option>)}</select></label>
        {snapshot.detectedType && snapshot.detectedType !== form.type && <div className="flex flex-wrap items-center gap-3 border-l-2 border-amber-400 pl-4 text-sm"><span>Detected {PROJECT_TYPES[snapshot.detectedType].label}</span><Button variant="outline" size="sm" onClick={() => update({ type: snapshot.detectedType! })}>Use detected framework</Button></div>}
        <div className="grid gap-4 sm:grid-cols-2">{runtimeIds.map(id => <label key={id} className="field-label">{id === 'node' ? 'Node.js' : id === 'php' ? 'PHP' : 'Go'} version<select className="control-input" value={form.versions[id] || ''} onChange={event => update({ versions: { ...form.versions, [id]: event.target.value } })}><option value="">Host default</option>{versions.find(runtime => runtime.id === id)?.installedVersions.map(version => <option key={version}>{version}</option>)}</select></label>)}</div>
        <div className="grid gap-4 sm:grid-cols-2"><label className="field-label">Build command<input className="control-input font-mono" value={form.build} onChange={event => update({ build: event.target.value })} placeholder={form.type === 'go' ? 'Automatic main-package detection' : PROJECT_TYPES[form.type].buildCmd || 'Automatic'} /></label><label className="field-label">Start command<input className="control-input font-mono" value={form.start} onChange={event => update({ start: event.target.value })} placeholder={PROJECT_TYPES[form.type].startCmd || 'Manager static server'} /></label></div>
        <label className="field-label">Deployment script <span className="font-normal text-muted-foreground">Optional override</span><textarea className="control-textarea min-h-64 font-mono" value={form.script} maxLength={50000} onChange={event => update({ script: event.target.value })} placeholder={form.type === 'laravel' ? 'composer install --no-interaction --prefer-dist --optimize-autoloader\nphp artisan migrate --force\nphp artisan optimize:clear\nphp artisan optimize\nnpm ci --include=dev\nnpm run build' : '# Leave empty for framework-managed installation and build'} spellCheck={false} /></label>
        <Button variant="outline" onClick={() => void run(save)}><Save className="mr-2 h-4 w-4" />Save runtime configuration</Button></fieldset>
        <div className="border-t border-border pt-4"><button className="text-sm text-primary" onClick={() => setShowDependencies(value => !value)}>{showDependencies ? 'Close dependency manager' : 'Manage host dependencies & versions'}</button>{showDependencies && <div className="mt-5"><RuntimeManager isAdmin={role === 'admin'} runtimeIds={['git', ...runtimeIds, ...(form.type === 'laravel' ? ['composer'] : [])]} /></div>}</div>
      </div>}
      {step === 'database' && <div className="space-y-6"><div className="setup-database">{database}</div><label className="flex items-center gap-3 border-t border-border pt-5 text-sm"><input type="checkbox" className="h-4 w-4 accent-emerald-400" checked={decisions.database === 'none'} onChange={event => setDecisions({ ...decisions, database: event.target.checked ? 'none' : 'attached' })} disabled={!canWrite || busy} />No managed database required</label></div>}
      {step === 'environment' && <div className="space-y-5"><label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-emerald-400" checked={decisions.environment === 'runtime'} onChange={event => setDecisions({ ...decisions, environment: event.target.checked ? 'runtime' : 'file' })} disabled={!canWrite || busy} />Runtime variables only</label>{decisions.environment !== 'runtime' && <><div className="flex items-center justify-between text-xs text-muted-foreground"><span className="font-mono">.env</span><span>{dirty ? 'Unsaved changes' : 'Application-scoped'}</span></div><fieldset disabled={!canWrite || busy || !envLoaded}><EnvEditor className="h-[32rem]" value={env} onChange={value => { setEnv(value); setDirty(true) }} placeholder="# Application environment" /></fieldset>{form.type === 'angular' && <p className="text-sm text-amber-300">Browser builds must not contain database passwords or private API keys.</p>}<Button variant="outline" onClick={() => void run(save)} disabled={!canWrite || busy || !envLoaded || !snapshot.checkout}><Save className="mr-2 h-4 w-4" />Save environment</Button></>}</div>}
      {step === 'domain' && <div className="space-y-6"><ProjectDomains projectId={projectId} port={snapshot.project.port} canManage={role === 'admin'} onChanged={() => { void load(); onChanged() }} /><label className="flex items-center gap-3 border-t border-border pt-5 text-sm"><input type="checkbox" className="h-4 w-4 accent-emerald-400" checked={decisions.domain === 'later'} onChange={event => setDecisions({ ...decisions, domain: event.target.checked ? 'later' : 'configured' })} disabled={!canWrite || busy} />Configure public domain later</label></div>}
      {step === 'review' && <div className="space-y-6"><dl className="summary-list"><div><dt>Application</dt><dd>{snapshot.project.name}</dd></div><div><dt>Framework</dt><dd>{PROJECT_TYPES[snapshot.project.project_type].label}</dd></div><div><dt>Port</dt><dd>{snapshot.project.port} / dynamically assigned</dd></div><div><dt>Domain</dt><dd className="break-all">{snapshot.project.url || 'Deferred'}</dd></div></dl><Button variant="outline" onClick={validate} disabled={busy || !canWrite}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Validate configuration</Button><div aria-live="polite" className="divide-y divide-border">{checks.map(check => <div key={check.id} className="flex gap-3 py-4">{check.status === 'pass' ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" /> : check.status === 'warning' ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" /> : <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />}<div className="min-w-0 flex-1"><p className="text-sm font-medium">{check.label}</p><p className="mt-1 text-xs text-muted-foreground break-words">{check.detail}</p></div>{check.status === 'fail' && <button className="text-xs text-primary shrink-0" onClick={() => navigate(check.step)}>Resolve</button>}</div>)}</div>{ready && <p className="text-sm text-emerald-300" role="status">Configuration checks passed. Build, migrations and application health are verified during deployment.</p>}</div>}
      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><Button variant="ghost" disabled={busy || step === 'repository'} onClick={() => navigate(SETUP_STEPS[SETUP_STEPS.indexOf(step) - 1])}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button><span className="text-xs text-muted-foreground">{busy ? 'Working...' : dirty ? 'Unsaved changes' : 'Progress saved to application'}</span>{step === 'review' ? <Button onClick={onDeploy} disabled={!ready || busy || deploying || !canWrite}><Rocket className="mr-2 h-4 w-4" />Deploy application</Button> : <Button onClick={next} disabled={busy || !canWrite}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button>}</footer>
    </section>
  </div>
}
