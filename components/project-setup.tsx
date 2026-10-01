'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Download, GitBranch, Loader2, RefreshCw, Rocket, Square, XCircle } from 'lucide-react'
import { SetupSteps, SETUP_LABELS } from '@/components/setup-steps'
import { Button } from '@/components/ui/button'
import { EnvEditor } from '@/components/env-editor'
import { RuntimeManager } from '@/components/runtime-manager'
import { StoragePanel } from '@/components/app/storage-panel'
import { DomainsPanel } from '@/components/app/domains-panel'
import { ChoiceCard } from '@/components/app/section'
import { FrameworkLogo } from '@/components/synergy/framework-logo'
import { PROJECT_TYPES, type ProjectType } from '@/lib/project-types'
import { SETUP_STEPS, type SetupStep, type SetupDecisions, type SetupCheck } from '@/lib/project-setup-policy'
import { cn } from '@/lib/utils'

interface SetupProject { id: string; name: string; root_path: string; project_type: ProjectType; repo_url: string; default_branch: string; port: number; url: string | null; environment?: string; runtime_versions: Record<string, string>; build_cmd: string | null; start_cmd: string | null; deploy_script: string | null; step: SetupStep | null; completed_at: string | null; decisions: SetupDecisions }
interface Snapshot { project: SetupProject; checkout: boolean; detectedType?: ProjectType; envExists: boolean; inspectionError?: string }

const descriptions: Record<SetupStep, string> = {
  repository: 'Synergy clones your repository onto this server and looks at it to work out how to build it.',
  runtime: 'Pick the framework and, if you need to, override how the app is installed, built and started.',
  database: 'Give the app somewhere to store data: a new database, one shared with its project, or one you already have.',
  environment: 'Secrets and settings your app reads at runtime, like API keys. They stay on this server.',
  domain: 'Choose the address people will use. HTTPS certificates are issued automatically.',
  review: 'Synergy checks everything is in place. Then deploy: the app is built and verified before it goes live.',
}

const repoName = (url: string) => url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')

export function ProjectSetup({ projectId, onChanged, onDeploy, deploying }: { projectId: string; onChanged: () => void; onDeploy: () => void; deploying: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [step, setStep] = useState<SetupStep>('repository')
  const [decisions, setDecisions] = useState<SetupDecisions>({})
  const [role, setRole] = useState<'admin' | 'operator' | 'viewer'>('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [log, setLog] = useState('')
  const [showLog, setShowLog] = useState(false)
  const [checks, setChecks] = useState<SetupCheck[]>([])
  const [ready, setReady] = useState(false)
  const [env, setEnv] = useState('')
  const [envLoaded, setEnvLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [form, setForm] = useState({ type: 'next' as ProjectType, build: '', start: '', script: '', versions: {} as Record<string, string> })
  const [versions, setVersions] = useState<{ id: string; installedVersions: string[] }[]>([])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showDependencies, setShowDependencies] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const initialized = useRef(false)
  const autoPrepared = useRef(false)
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
      setShowAdvanced(!!(body.project.build_cmd || body.project.start_cmd || body.project.deploy_script))
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
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const save = async () => {
    if (step === 'runtime') await json(endpoint, { projectType: form.type, buildCmd: form.build.trim() || null, startCmd: form.start.trim() || null, deployScript: form.script.trim() || null, runtimeVersions: form.versions }, 'PATCH')
    if (step === 'environment' && decisions.environment !== 'runtime') {
      if (!envLoaded) throw new Error('Wait for the environment file to load')
      await json(endpoint + '/env', { file: '.env', content: env })
    }
    setDirty(false); setNotice('Saved'); setReady(false); await load(); onChanged()
  }
  const navigate = (next: SetupStep) => {
    if (canWrite) void run(async () => { if (dirty) await save(); await progress(next) }); else setStep(next)
  }
  const prepare = useCallback(() => void run(async () => {
    abort.current = new AbortController(); setLog(''); setShowLog(true)
    const response = await fetch(endpoint + '/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare' }), signal: abort.current.signal })
    if (!response.ok) throw new Error((await response.json()).error)
    const reader = response.body!.getReader(); const decoder = new TextDecoder()
    while (true) { const result = await reader.read(); if (result.done) break; setLog(current => (current + decoder.decode(result.value, { stream: true })).slice(-100000)) }
    const loaded = await load(); if (!loaded.checkout) throw new Error('The repository could not be prepared. Check the output below.')
    setShowLog(false)
    if (loaded.detectedType) setForm(current => ({ ...current, type: loaded.detectedType! }))
    onChanged()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [endpoint, load, onChanged])

  // Coming straight from "Import", start cloning without an extra click.
  useEffect(() => {
    if (autoPrepared.current || !snapshot || !canWrite || step !== 'repository' || snapshot.checkout) return
    if (new URLSearchParams(window.location.search).get('new') !== '1') return
    autoPrepared.current = true
    prepare()
  }, [snapshot, canWrite, step, prepare])

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

  // Re-check automatically when arriving at the final step.
  useEffect(() => {
    if (step === 'review' && canWrite && !checks.length && snapshot) validate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, canWrite, snapshot === null])

  if (!snapshot) return <div className="py-16 text-center">{error ? <p role="alert" className="text-red-300">{error}</p> : <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label="Loading application setup" />}</div>
  const runtimeIds = form.type === 'go' ? ['go'] : form.type === 'laravel' ? ['php', 'node'] : ['node']
  const index = SETUP_STEPS.indexOf(step)
  const completed = SETUP_STEPS.filter((value, position) => position < SETUP_STEPS.indexOf(snapshot.project.step || 'repository') || (value === 'repository' && snapshot.checkout))

  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-6">
        <SetupSteps step={step} onSelect={navigate} disabled={busy} completed={completed} />
        <div className="hidden rounded-xl border border-border bg-card p-4 text-xs lg:block">
          <p className="eyebrow">Your app</p>
          <div className="flex items-center gap-2"><FrameworkLogo type={form.type} className="h-5 w-5" /><span className="truncate text-sm font-medium">{snapshot.project.name}</span></div>
          <dl className="mt-3 space-y-2 text-muted-foreground">
            <div className="flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5" /><span className="truncate">{snapshot.project.default_branch}</span></div>
            <div className="truncate font-mono">{repoName(snapshot.project.repo_url)}</div>
            <div>Port <span className="font-mono text-foreground">{snapshot.project.port}</span></div>
          </dl>
        </div>
      </aside>

      <section className="min-w-0" aria-label={SETUP_LABELS[step].title}>
        <div className="mb-6">
          <p className="eyebrow">Step {index + 1} of {SETUP_STEPS.length}</p>
          <h2 className="text-2xl font-semibold tracking-[-0.02em]">{({ repository: 'Import the source', runtime: 'Build settings', database: 'Database', environment: 'Environment variables', domain: 'Domain', review: 'Ready to deploy' } as Record<SetupStep, string>)[step]}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{descriptions[step]}</p>
        </div>
        {error && <div role="alert" className="notice-error">{error}</div>}
        {notice && <p role="status" className="mb-4 flex items-center gap-1.5 text-sm text-emerald-300"><Check className="h-4 w-4" />{notice}</p>}

        {step === 'repository' && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-4 p-5">
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-black"><svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{repoName(snapshot.project.repo_url)}</p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><GitBranch className="h-3.5 w-3.5" />{snapshot.project.default_branch}<span className="truncate font-mono">· {snapshot.project.root_path}</span></p>
                </div>
                <div className="flex gap-2">
                  <Button variant={snapshot.checkout ? 'outline' : 'default'} disabled={busy || !canWrite} onClick={prepare}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : snapshot.checkout ? <RefreshCw className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}{busy ? 'Cloning…' : snapshot.checkout ? 'Re-inspect' : 'Clone repository'}</Button>
                  {busy && <Button variant="outline" size="icon" title="Cancel" aria-label="Cancel repository preparation" onClick={() => abort.current?.abort()}><Square className="h-4 w-4" /></Button>}
                </div>
              </div>
              <div className="grid border-t border-border sm:grid-cols-2">
                <div className="flex items-center gap-3 px-5 py-4">
                  {snapshot.checkout ? <CheckCircle2 className="h-5 w-5 text-status-ready" /> : busy ? <Loader2 className="h-5 w-5 animate-spin text-syn-cyan" /> : <span className="h-5 w-5 rounded-full border border-white/20" />}
                  <div><p className="text-sm font-medium">{snapshot.checkout ? 'Source ready' : busy ? 'Cloning…' : 'Not cloned yet'}</p><p className="text-xs text-muted-foreground">{snapshot.checkout ? 'Repository is on the server' : 'Takes a few seconds for most repositories'}</p></div>
                </div>
                <div className="flex items-center gap-3 border-t border-border px-5 py-4 sm:border-l sm:border-t-0">
                  {snapshot.detectedType ? <FrameworkLogo type={snapshot.detectedType} className="h-5 w-5" /> : <span className="h-5 w-5 rounded-full border border-white/20" />}
                  <div><p className="text-sm font-medium">{snapshot.detectedType ? `${PROJECT_TYPES[snapshot.detectedType].label} detected` : 'Framework not detected yet'}</p><p className="text-xs text-muted-foreground">{snapshot.detectedType ? 'Build settings are filled in for you' : 'Detected after cloning'}</p></div>
                </div>
              </div>
            </div>
            {log && (
              <div className="overflow-hidden rounded-xl border border-border">
                <button type="button" onClick={() => setShowLog(value => !value)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !showLog && '-rotate-90')} />Clone output</button>
                {showLog && <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border bg-black p-4 font-mono text-xs leading-5 text-[#d6d6d6]" aria-live="polite">{log}</pre>}
              </div>
            )}
          </div>
        )}

        {step === 'runtime' && (
          <fieldset disabled={!canWrite || busy} className="space-y-6">
            <div className="space-y-2">
              <p className="text-sm font-medium">Framework</p>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Framework">
                {(Object.keys(PROJECT_TYPES) as ProjectType[]).map(type => (
                  <ChoiceCard key={type} selected={form.type === type} onSelect={() => update({ type })} icon={<FrameworkLogo type={type} className="h-5 w-5" />} title={PROJECT_TYPES[type].label}
                    badge={snapshot.detectedType === type ? <span className="rounded-full bg-status-ready/15 px-1.5 py-px text-[10px] text-emerald-300">Detected</span> : undefined}
                    description={PROJECT_TYPES[type].startCmd ? `Runs ${PROJECT_TYPES[type].startCmd}` : 'Static files served by Synergy'} />
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">{runtimeIds.map(id => <label key={id} className="field-label">{id === 'node' ? 'Node.js' : id === 'php' ? 'PHP' : 'Go'} version<select className="control-input" value={form.versions[id] || ''} onChange={event => update({ versions: { ...form.versions, [id]: event.target.value } })}><option value="">Server default</option>{versions.find(runtime => runtime.id === id)?.installedVersions.map(version => <option key={version}>{version}</option>)}</select></label>)}</div>
            <div className="overflow-hidden rounded-xl border border-border">
              <button type="button" onClick={() => setShowAdvanced(value => !value)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-white/[0.02]" aria-expanded={showAdvanced}><ChevronDown className={cn('h-4 w-4 transition-transform', !showAdvanced && '-rotate-90')} />Build and start commands<span className="ml-auto text-xs font-normal text-muted-foreground">{form.build || form.start || form.script ? 'Customized' : 'Using framework defaults'}</span></button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-border p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="field-label">Build command<input className="control-input font-mono" value={form.build} onChange={event => update({ build: event.target.value })} placeholder={form.type === 'go' ? 'Detected automatically' : PROJECT_TYPES[form.type].buildCmd || 'None'} /></label>
                    <label className="field-label">Start command<input className="control-input font-mono" value={form.start} onChange={event => update({ start: event.target.value })} placeholder={PROJECT_TYPES[form.type].startCmd || 'Synergy static server'} /></label>
                  </div>
                  <label className="field-label">Custom deployment script <span className="font-normal text-muted-foreground">Replaces install and build when set</span><textarea className="control-textarea min-h-48 font-mono" value={form.script} maxLength={50000} onChange={event => update({ script: event.target.value })} placeholder={form.type === 'laravel' ? 'composer install --no-interaction --prefer-dist --optimize-autoloader\nphp artisan migrate --force\nnpm ci --include=dev\nnpm run build' : '# Leave empty to let Synergy install and build for you'} spellCheck={false} /></label>
                </div>
              )}
            </div>
            <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => setShowDependencies(value => !value)}>{showDependencies ? 'Hide server runtimes' : 'Need another Node, PHP or Go version? Manage server runtimes'}</button>
            {showDependencies && <div className="rounded-xl border border-border p-4"><RuntimeManager isAdmin={role === 'admin'} runtimeIds={['git', ...runtimeIds, ...(form.type === 'laravel' ? ['composer'] : [])]} /></div>}
          </fieldset>
        )}

        {step === 'database' && (
          <div className="space-y-4">
            <StoragePanel projectId={projectId} projectName={snapshot.project.name} projectType={form.type} role={role} onChanged={() => { setDecisions(current => ({ ...current, database: 'attached' })); onChanged() }} />
            {form.type !== 'angular' && (
              <label className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-white" checked={decisions.database === 'none'} onChange={event => setDecisions({ ...decisions, database: event.target.checked ? 'none' : 'attached' })} disabled={!canWrite || busy} />
                <span><span className="font-medium">This app doesn&apos;t need a database</span><span className="block text-xs text-muted-foreground">You can add one later from the Storage tab.</span></span>
              </label>
            )}
          </div>
        )}

        {step === 'environment' && (
          <div className="space-y-4">
            <label className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-white" checked={decisions.environment === 'runtime'} onChange={event => setDecisions({ ...decisions, environment: event.target.checked ? 'runtime' : 'file' })} disabled={!canWrite || busy} />
              <span><span className="font-medium">No .env file needed</span><span className="block text-xs text-muted-foreground">Database and port variables are still provided automatically.</span></span>
            </label>
            {decisions.environment !== 'runtime' && <>
              <div className="overflow-hidden rounded-xl border border-border">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5 text-xs text-muted-foreground"><span className="font-mono">.env</span><span>{dirty ? 'Unsaved changes' : 'Tip: paste your whole .env file'}</span></div>
                <fieldset disabled={!canWrite || busy || !envLoaded}><EnvEditor className="h-[26rem] rounded-none border-0" value={env} onChange={value => { setEnv(value); setDirty(true) }} placeholder={'# KEY=value\nAPI_KEY=…'} /></fieldset>
              </div>
              {form.type === 'angular' && <p className="flex items-start gap-2 text-sm text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Browser builds expose every variable to visitors. Never put passwords or private keys here.</p>}
            </>}
          </div>
        )}

        {step === 'domain' && (
          <div className="space-y-4">
            <DomainsPanel projectId={projectId} projectName={snapshot.project.name} port={snapshot.project.port} environment={snapshot.project.environment || 'production'} role={role} onChanged={() => { setDecisions(current => ({ ...current, domain: 'configured' })); void load(); onChanged() }} />
            <label className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-white" checked={decisions.domain === 'later'} onChange={event => setDecisions({ ...decisions, domain: event.target.checked ? 'later' : 'configured' })} disabled={!canWrite || busy} />
              <span><span className="font-medium">Set up a domain later</span><span className="block text-xs text-muted-foreground">The app is still reachable on the server at localhost:{snapshot.project.port}.</span></span>
            </label>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-5 py-3">
                <h3 className="text-sm font-semibold">Pre-deployment checks</h3>
                <Button variant="ghost" size="sm" onClick={validate} disabled={busy || !canWrite}>{busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}Check again</Button>
              </div>
              <div aria-live="polite" className="divide-y divide-border">
                {!checks.length && <p className="px-5 py-8 text-center text-sm text-muted-foreground">{busy ? 'Checking your configuration…' : 'Run the checks to continue.'}</p>}
                {checks.map(check => (
                  <div key={check.id} className="flex gap-3 px-5 py-3.5">
                    {check.status === 'pass' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-ready" /> : check.status === 'warning' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-building" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />}
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{check.label}</p><p className="mt-0.5 break-words text-xs text-muted-foreground">{check.detail}</p></div>
                    {check.status !== 'pass' && <button className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => navigate(check.step)}>{check.status === 'fail' ? 'Fix' : 'Review'}</button>}
                  </div>
                ))}
              </div>
            </div>
            {ready && (
              <div className="relative overflow-hidden rounded-xl border border-border bg-black p-6">
                <div className="syn-canvas pointer-events-none absolute inset-0 opacity-60" aria-hidden="true" />
                <div className="relative flex flex-wrap items-center justify-between gap-4">
                  <div><p className="text-lg font-semibold">Everything is ready</p><p className="text-sm text-muted-foreground">Synergy builds and health-checks the app before it receives any traffic.</p></div>
                  <Button size="lg" className="h-11" onClick={onDeploy} disabled={busy || deploying || !canWrite}>{deploying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}Deploy {snapshot.project.name}</Button>
                </div>
              </div>
            )}
          </div>
        )}

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <Button variant="ghost" disabled={busy || step === 'repository'} onClick={() => navigate(SETUP_STEPS[index - 1])}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>
          <span className="text-xs text-muted-foreground">{busy ? 'Working…' : dirty ? 'Unsaved changes' : 'Progress is saved automatically'}</span>
          {step === 'review'
            ? <Button onClick={onDeploy} disabled={!ready || busy || deploying || !canWrite}><Rocket className="mr-2 h-4 w-4" />Deploy</Button>
            : <Button onClick={next} disabled={busy || !canWrite || (step === 'repository' && !snapshot.checkout)}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button>}
        </footer>
      </section>
    </div>
  )
}
