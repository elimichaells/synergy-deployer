'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Activity, Bot, Database, RefreshCw, ShieldCheck } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import type { Diagnosis } from '@/lib/ai-operations-policy'
import type { UptimeReport } from '@/scripts/uptime-history.cjs'

type Settings = { enabled: boolean; configured: boolean; model: string; recoveryEnabled: boolean }
type Review = { id: string; projectName: string; expiresAt: string; action: string; impact: string; verification: string; rollback: string }
type DatabaseReview = {
  projectName: string; files: { file: string; present: string[]; empty: string[] }[]; missing: string[]
  services: { id: string; name: string; provider: string; primary: boolean; hasStoredCredential: boolean; adopted: boolean }[]
  warnings: string[]; nextSteps: string[]; limitations: string; href: string
}
type Data = {
  diagnosis: Diagnosis; settings: Settings; role: string; checkedAt: string | null; stale: boolean
  apps: { id: string; name: string; pm2_name: string }[]
  mapping: { service: string; name: string }[]
  uptime: UptimeReport & { unavailable: boolean; stale: boolean }
  history: { id: string; kind: string; status: string; created_at: string; details: { message?: string; service?: string; diagnosis?: Diagnosis; mapping?: { service: string; name: string }[] } }[]
}
const panel = 'rounded-xl border border-border bg-card p-5'
const button = 'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'
const input = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
const actionLabels: Record<string, string> = { review_database: 'Review database configuration', review_restart: 'Review recovery eligibility', inspect_dependency: 'Inspect the failing dependency', observe: 'Continue monitoring' }
const when = (value: string | number) => new Date(value).toLocaleString()

export default function OperationsPage() {
  const [data, setData] = useState<Data | null>(null)
  const [range, setRange] = useState('24h')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [project, setProject] = useState('')
  const [diagnosis, setDiagnosis] = useState<(Diagnosis & { mapping?: Data['mapping'] }) | null>(null)
  const [database, setDatabase] = useState<DatabaseReview | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [recoveryEnabled, setRecoveryEnabled] = useState(true)
  const [removeKey, setRemoveKey] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/operations?range=' + range, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
      const result = await r.json()
      if (!r.ok) throw Error(result.error || 'Operations could not be loaded')
      setData(result)
    } catch (e) { setError((e as Error).message) }
  }, [range])
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 30000); return () => clearInterval(timer) }, [refresh])
  useEffect(() => {
    if (!settingsLoaded && data) {
      setModel(data.settings.model); setEnabled(data.settings.enabled); setRecoveryEnabled(data.settings.recoveryEnabled); setSettingsLoaded(true)
    }
  }, [data, settingsLoaded])
  async function post(action: string, fields: Record<string, unknown> = {}) {
    setBusy(action); setError(''); setNotice('')
    try {
      const response = await fetch('/api/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) })
      const result = await response.json()
      if (!response.ok) throw Error(result.error || 'The request could not be completed')
      if (result.diagnosis) setDiagnosis(result.diagnosis)
      if (result.database) setDatabase(result.database)
      if (result.review) { setReview(result.review); setConfirmed(false) }
      if (result.result) { setReview(null); setNotice(result.result.message) }
      if (result.cancelled) { setReview(null); setConfirmed(false); setNotice('Recovery review cancelled. No action was run.') }
      if (result.settings) { setApiKey(''); setRemoveKey(false); setNotice('Operations settings saved.'); setSettingsLoaded(false) }
      if (action === 'acknowledge') setNotice('Recovery incident marked reviewed.')
      await refresh()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy('') }
  }
  const operator = !!data && ['admin', 'operator'].includes(data.role)
  const shown = diagnosis || data?.diagnosis
  return <AppShell title="AI Operations" subtitle="Diagnose incidents, review recovery and track application availability." area="infrastructure"
    actions={<button className={button} disabled={!!busy} onClick={() => { setError(''); void refresh() }}><RefreshCw className="h-4 w-4" />Refresh evidence</button>}>
    <div className="space-y-6">
      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-200">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-500/40 p-4 text-sm">{notice}</div>}
      {!data ? <p className="text-sm text-muted-foreground">Loading operations evidence…</p> : <>
        <div className="grid gap-4 md:grid-cols-3">
          <div className={panel}><Bot className="mb-3 h-5 w-5 text-violet-300" /><p className="font-medium">{data.settings.enabled && data.settings.configured ? 'AI configured' : 'Local diagnosis active'}</p><p className="mt-1 text-xs text-muted-foreground">{data.settings.enabled ? data.settings.model : 'Connect AI below for additional analysis.'}</p></div>
          <div className={panel}><ShieldCheck className="mb-3 h-5 w-5 text-emerald-300" /><p className="font-medium">{data.settings.recoveryEnabled ? 'Review required' : 'Recovery paused'}</p><p className="mt-1 text-xs text-muted-foreground">Every restart requires an explicit, app-specific approval.</p></div>
          <div className={panel}><Activity className="mb-3 h-5 w-5 text-blue-300" /><p className="font-medium">{data.stale ? 'Evidence overdue' : 'Monitoring active'}</p><p className="mt-1 text-xs text-muted-foreground">{data.checkedAt ? when(data.checkedAt) : 'Waiting for the independent monitor'}</p></div>
        </div>
        <section className={panel} aria-label="Incident diagnosis">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Incident diagnosis</h2>
            <button className={button} disabled={!!busy || !operator || data.stale || !data.settings.enabled || !data.settings.configured} onClick={() => void post('diagnose')}><Bot className="h-4 w-4" />{busy === 'diagnose' ? 'Analyzing…' : 'Analyze with AI'}</button></div>
          <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">{shown?.source === 'openai' ? 'AI analysis · recommendations require review' : 'Local rules · no model request'}</p>
          <p className="mt-2 text-sm">{shown?.summary}</p>
          {!!shown?.evidence.length && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{shown.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <div className="mt-4 flex flex-wrap gap-2">{shown?.recommendations.map((r, i) => <span key={i} className="rounded-full border border-border px-3 py-1 text-xs">{actionLabels[r]}</span>)}</div>
          <p className="mt-4 text-xs text-muted-foreground">{shown?.limitations.join(' ')}</p>
          {diagnosis?.mapping && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Service references used in this analysis</summary><ul className="mt-2 grid gap-1 sm:grid-cols-2">{diagnosis.mapping.map(m => <li key={m.service}>{m.service}: {m.name}</li>)}</ul></details>}
          <p className="mt-3 text-xs text-muted-foreground">AI requests contain anonymous service references and bounded monitoring metrics. Credentials, logs and source code are excluded. Up to 50 requests per rolling day; one request per minute.</p>
        </section>
        <section className={panel} aria-label="Application assistance">
          <h2 className="font-semibold">Application assistance</h2>
          <p className="mt-1 text-sm text-muted-foreground">Inspect database setup or prepare a recovery review for a confirmed application incident.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <label className="min-w-0 flex-1"><span className="sr-only">Application</span><select className={input} value={project} disabled={!!busy || !!review} onChange={e => { setProject(e.target.value); setDatabase(null) }}><option value="">Select an application</option>{data.apps.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <button className={button} disabled={!!busy || !operator || !project} onClick={() => void post('database', { projectId: project })}><Database className="h-4 w-4" />Review database</button>
            <button className={button} disabled={!!busy || !operator || !project || !!review || data.stale || !data.settings.recoveryEnabled} onClick={() => void post('prepare-recovery', { projectId: project })}>Review recovery</button>
          </div>
          {database && <div className="mt-5 space-y-3 border-t border-border pt-4">
            <h3 className="font-medium">{database.projectName}: database configuration</h3>
            {database.warnings.map((w, i) => <p key={i} className="text-sm text-amber-200">{w}</p>)}
            <div className="grid gap-3 sm:grid-cols-2">{database.files.map(f => <div key={f.file} className="rounded-lg border border-border p-3 text-xs"><p className="font-mono font-medium">{f.file}</p><p className="mt-2 break-words text-muted-foreground">Present keys: {f.present.join(', ') || 'none detected'}</p>{!!f.empty.length && <p className="mt-1 text-amber-200">Empty keys: {f.empty.join(', ')}</p>}</div>)}</div>
            {!database.files.length && <p className="text-sm text-muted-foreground">No supported environment file was found. The application may receive configuration at runtime.</p>}
            {database.services.map(s => <p key={s.id} className="text-sm">{s.name} · {s.provider} · {s.primary ? 'primary' : 'secondary'} · {s.adopted ? 'existing configuration' : s.hasStoredCredential ? 'encrypted credential stored' : 'no stored password'}</p>)}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">{database.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            <p className="text-xs text-muted-foreground">{database.limitations}</p>
            <Link className="inline-block text-sm underline" href={database.href}>Open application storage settings</Link>
          </div>}
          {review && <div className="mt-5 space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4" role="region" aria-label="Recovery approval">
            <h3 className="font-semibold">Review restart: {review.projectName}</h3>
            <p className="text-sm">{review.action}</p><p className="text-sm text-amber-200">{review.impact}</p>
            <p className="text-sm text-muted-foreground">{review.verification} {review.rollback}</p>
            <p className="text-xs text-muted-foreground">Expires {when(review.expiresAt)}. State changes require a new review.</p>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={!!busy} onChange={e => setConfirmed(e.target.checked)} />I approve this one restart and its temporary interruption to {review.projectName}.</label>
            <div className="flex flex-wrap gap-3"><button className={button} disabled={!!busy || !confirmed || Date.parse(review.expiresAt) < Date.now()} onClick={() => void post('execute-recovery', { reviewId: review.id, confirm: true })}>{busy === 'execute-recovery' ? 'Recovering and verifying…' : 'Approve and restart this app'}</button><button className={button} disabled={!!busy} onClick={() => void post('cancel-recovery', { reviewId: review.id })}>Cancel review</button></div>
          </div>}
        </section>
        <section className={panel} aria-label="Uptime tracking">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Sampled uptime</h2><label className="flex items-center gap-2 text-sm">Window<select className={input} value={range} onChange={e => setRange(e.target.value)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label></div>
          <p className="mt-2 text-sm text-muted-foreground">99.9% readiness target per service. One sample per minute; these checks do not measure every request or public DNS, TLS and network availability.</p>
          {(data.uptime.unavailable || data.uptime.stale) && <p className="mt-3 text-sm text-amber-200">Uptime collection is starting or overdue. Coverage remains unknown until fresh samples arrive.</p>}
          <div className="mt-4 max-h-[28rem] overflow-auto"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-card"><tr className="text-xs text-muted-foreground">{['Service', 'Readiness', 'Coverage', 'Failed checks', 'Unknown / missing', 'Paused', 'Target assessment'].map(h => <th key={h} className="whitespace-nowrap px-3 py-3">{h}</th>)}</tr></thead><tbody>{data.uptime.services.map(s => <tr key={s.name} className="border-t border-border">
            <td className="px-3 py-3 font-medium">{s.name}</td><td className="px-3 py-3 tabular-nums">{s.percent === null ? '—' : s.percent.toFixed(3) + '%'}</td><td className="px-3 py-3 tabular-nums">{s.coverage.toFixed(1)}%</td><td className="px-3 py-3">{s.down}</td><td className="px-3 py-3">{s.unknown} / {s.missing}</td><td className="px-3 py-3">{s.paused}</td><td className={`px-3 py-3 text-xs ${s.assessment === 'below-target' ? 'text-red-300' : 'text-muted-foreground'}`}>{data.uptime.stale ? 'Evidence overdue' : s.assessment === 'insufficient-coverage' ? 'Insufficient coverage' : s.assessment === 'within-target' ? 'Within sampled target' : 'Below sampled target'}</td>
          </tr>)}</tbody></table></div>
          {!data.uptime.services.length && <p className="mt-3 text-sm text-muted-foreground">The independent monitor will begin recording uptime after this release starts.</p>}
          <p className="mt-3 text-xs text-muted-foreground">Coverage is completed readiness checks divided by expected minute slots in the selected window. Unknown, missing and paused observations never count as successful checks. Target assessment requires at least 99% coverage. History is retained for 30 days and is not backfilled.</p>
        </section>
        {data.role === 'admin' && <details className={panel}><summary className="cursor-pointer font-semibold">AI connection and recovery controls</summary><form className="mt-4 space-y-4" onSubmit={e => { e.preventDefault(); void post('settings', { enabled, recoveryEnabled, model, ...(apiKey ? { apiKey } : {}), removeKey }) }}>
          <p className="text-sm text-muted-foreground">OpenAI is optional. Local diagnosis, database assistance, reviewed recovery and uptime tracking work without a model connection.</p>
          <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm"><span>API model ID</span><input className={input} value={model} onChange={e => setModel(e.target.value)} maxLength={100} placeholder="Enter a model available to your API project" /></label>
            <label className="space-y-2 text-sm"><span>OpenAI API key {data.settings.configured ? '(stored securely)' : ''}</span><input className={input} type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={data.settings.configured ? 'Leave blank to retain the saved key' : 'Enter your project API key'} /></label></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable AI analysis on request using anonymized monitoring metrics</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recoveryEnabled} onChange={e => setRecoveryEnabled(e.target.checked)} />Allow new reviewed application recovery</label>
          {data.settings.configured && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removeKey} onChange={e => { setRemoveKey(e.target.checked); if (e.target.checked) setEnabled(false) }} />Remove the saved API key</label>}
          <p className="text-xs text-muted-foreground">The key is encrypted and never returned to the browser. AI requests use store:false; provider data policies still apply. Alerts remain inside Manager. No scheduled AI calls or autonomous repairs are enabled.</p>
          <button className={button} disabled={!!busy}>Save operations settings</button>
        </form></details>}
        <section className={panel}><h2 className="font-semibold">Operations history</h2><p className="mt-1 text-xs text-muted-foreground">Latest 50 attempts. A failed or interrupted recovery requires review; it never triggers another automatic restart.</p>
          {!data.history.length ? <p className="mt-4 text-sm text-muted-foreground">No AI requests or recovery attempts have been recorded yet.</p> : <ul className="mt-4 divide-y divide-border">{data.history.map(event => <li key={event.id} className="py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><p className="font-medium">{event.kind === 'diagnosis' ? 'AI diagnosis' : 'Application recovery'}{event.details.service ? ` · ${event.details.service}` : ''}</p><span className="text-xs capitalize text-muted-foreground">{event.status === 'running' && Date.now() - Date.parse(event.created_at) > 600000 ? 'Verification interrupted' : event.status}</span></div>
            <p className="mt-1 text-xs text-muted-foreground">{when(event.created_at)}</p>{event.details.message && <p className="mt-2 text-sm">{event.details.message}</p>}
            {event.details.diagnosis && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">View recorded analysis</summary><p className="mt-2">{event.details.diagnosis.summary}</p><ul className="mt-2 list-disc pl-4">{event.details.diagnosis.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul><p className="mt-2">{event.details.mapping?.map(m => `${m.service}: ${m.name}`).join(' · ')}</p></details>}
            {operator && event.kind === 'recovery' && (event.status === 'failed' || event.status === 'running' && Date.now() - Date.parse(event.created_at) > 600000) && <button className={`${button} mt-2`} disabled={!!busy} onClick={() => void post('acknowledge', { eventId: event.id })}>Mark incident reviewed</button>}
          </li>)}</ul>}
        </section>
        <p className="text-xs text-muted-foreground">Alerts stay inside the deployer. When its host is unreachable, review the recorded evidence after access returns. <Link href="/infrastructure/health" className="underline">Open Health & alerts</Link></p>
      </>}
    </div>
  </AppShell>
}
