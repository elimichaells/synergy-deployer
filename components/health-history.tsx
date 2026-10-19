'use client'

import { useEffect, useState } from 'react'
import type { HealthHistory } from '@/scripts/health-history.cjs'

const percent = (value: number | null) => value === null ? 'No checks' : `${value.toFixed(2)}%`
const millis = (value: number | null) => value === null ? '—' : `${Math.round(value)} ms`
const timestamp = (value: number) => new Date(value).toLocaleString()
const colors = { gap: '#334155', failed: '#f87171', unknown: '#fbbf24', healthy: '#34d399', paused: '#64748b', partial: '#a78bfa' }

export function HealthHistoryPanel() {
  const [range, setRange] = useState('24h'), [service, setService] = useState('')
  const [data, setData] = useState<HealthHistory | null>(null), [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController(); let active = true, inFlight = false
    setData(null); setLoading(true); setError(false)
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const parameters = new URLSearchParams({ range }); if (service) parameters.set('service', service)
        const response = await fetch(`/api/server/health/history?${parameters}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (!response.ok) throw new Error('History unavailable')
        const next = await response.json()
        if (active) { setData(next); setError(false) }
      } catch { if (active) setError(true) }
      finally { inFlight = false; if (active) setLoading(false) }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 60_000)
    return () => { active = false; controller.abort(); clearInterval(timer) }
  }, [range, service])
  const maxMs = Math.max(1, ...((data?.points || []).map(p => p.averageMs || 0)))
  return <section aria-label="Health history" className="rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="font-medium">Health history</h2><p className="mt-1 text-sm text-muted-foreground">Successful readiness checks and response times over the last seven days.</p></div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-muted-foreground">Service<select aria-label="History service" value={service} onChange={e => setService(e.target.value)} className="ml-2 max-w-[240px] rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"><option value="">All monitored services</option>{data?.services.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}{service && !data?.services.some(s => s.name === service) && <option value={service}>{service}</option>}</select></label>
        <div className="flex rounded-md border border-border p-1" role="group" aria-label="History period">{[['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days']].map(([value, label]) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)} className={`rounded px-3 py-1.5 text-xs ${range === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>{label}</button>)}</div>
      </div>
    </div>
    {loading ? <p className="mt-5 text-sm text-muted-foreground" role="status">Loading history…</p> : error || data?.unavailable ? <p className="mt-5 text-sm text-amber-200" role="status">Health history is unavailable. Check the independent monitor task; missing observations are not counted as healthy.</p> : data && <>
      {data.stale && <p role="status" className="mt-4 text-sm text-amber-200">History collection is overdue. These are the last recorded observations.</p>}
      <div className="my-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div><p className="text-xs text-muted-foreground">Successful checks</p><p className="mt-1 text-2xl font-semibold tabular-nums">{percent(data.summary.successPercent)}</p><p className="text-xs text-muted-foreground">{data.summary.passed.toLocaleString()} of {(data.summary.passed + data.summary.failed).toLocaleString()} completed</p></div>
        <div><p className="text-xs text-muted-foreground">Average response</p><p className="mt-1 text-2xl font-semibold tabular-nums">{millis(data.summary.averageMs)}</p><p className="text-xs text-muted-foreground">HTTP responses, including failures</p></div>
        <div><p className="text-xs text-muted-foreground">Failed checks</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${data.summary.failed ? 'text-red-300' : ''}`}>{data.summary.failed.toLocaleString()}</p><p className="text-xs text-muted-foreground">Unexpected responses or unreachable services</p></div>
        <div><p className="text-xs text-muted-foreground">Unverified checks</p><p className="mt-1 text-2xl font-semibold tabular-nums">{data.summary.unknown.toLocaleString()}</p><p className="text-xs text-muted-foreground">{data.summary.paused.toLocaleString()} intentionally paused</p></div>
      </div>
      <p className="mb-2 text-xs font-medium">Readiness timeline</p>
      <svg viewBox="0 0 1000 24" role="img" aria-label="Readiness history: green is healthy, red has failures, amber is unknown, grey is missing or paused" className="h-7 w-full rounded">
        {data.points.map((p, i) => <rect key={p.at} x={i * 1000 / data.points.length} width={Math.max(.5, 1000 / data.points.length - 1)} height={24} fill={colors[p.state]}><title>{timestamp(p.at)} — {p.state}; {p.passed} passed, {p.failed} failed, {p.unknown} unknown, {p.paused} paused, {p.missing} missing</title></rect>)}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{[['healthy', 'Healthy'], ['failed', 'Failed'], ['unknown', 'Unknown'], ['partial', 'Partial coverage'], ['gap', 'No observations'], ['paused', 'Paused']].map(([key, label]) => <span key={key} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: colors[key as keyof typeof colors] }} />{label}</span>)}</div>
      <p className="mb-2 mt-5 text-xs font-medium">Average response time <span className="font-normal text-muted-foreground">· scale 0–{Math.ceil(maxMs)} ms</span></p>
      <svg viewBox="0 0 1000 70" role="img" aria-label="Average response time by observation interval, with gaps where no HTTP response was recorded" className="h-20 w-full border-b border-border">
        {data.points.map((p, i) => p.averageMs === null ? null : <rect key={p.at} x={i * 1000 / data.points.length} y={70 - Math.max(1, p.averageMs / maxMs * 68)} width={Math.max(.5, 1000 / data.points.length - 1)} height={Math.max(1, p.averageMs / maxMs * 68)} fill={p.failed ? '#f87171' : '#60a5fa'}><title>{timestamp(p.at)} — average {millis(p.averageMs)}, maximum {millis(p.maxMs)}</title></rect>)}
      </svg>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{timestamp(data.from)}</span><span>{timestamp(data.to)}</span></div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">Checks are sampled once per minute. Missing observations and paused services are excluded from the success percentage; it is not a measurement of every user request. History began {data.startedAt ? timestamp(data.startedAt) : 'when the monitor starts collecting'}. Last observation: {data.checkedAt ? timestamp(data.checkedAt) : 'none'}.</p>
      <details className="mt-4"><summary className="cursor-pointer text-sm">Service history details</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="py-2 pr-4">Service</th><th className="px-3 py-2">Successful checks</th><th className="px-3 py-2">Failures</th><th className="px-3 py-2">Average</th><th className="px-3 py-2">Unknown / paused</th></tr></thead><tbody>{data.services.map(s => <tr key={s.name} className="border-t border-border"><td className="py-2 pr-4"><button type="button" onClick={() => setService(s.name)} className="text-left underline underline-offset-4">{s.name}</button></td><td className="px-3 py-2 tabular-nums">{percent(s.successPercent)}</td><td className="px-3 py-2 tabular-nums">{s.failed}</td><td className="px-3 py-2 tabular-nums">{millis(s.averageMs)}</td><td className="px-3 py-2 tabular-nums">{s.unknown} / {s.paused}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>
}
