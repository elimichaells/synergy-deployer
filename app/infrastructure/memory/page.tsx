'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowUpRight, CheckCircle2, Info, RefreshCw } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Section } from '@/components/app/section'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface AppRow { name: string; projectId: string | null; label: string; environment: string | null; privateMb: number; processes: number; limitMb: number | null; peakMb: number }
interface Overview {
  snapshot: {
    takenAt: string; totalMb: number; availableMb: number; commitMb: number | null; commitLimitMb: number | null
    pageFileMb: number | null; pageFileUsedMb: number | null; apps: AppRow[]; others: { name: string; count: number; privateMb: number }[]
  }
  history: { takenAt: string; availableMb: number; commitMb: number | null }[]
  alerts: { id: string; kind: string; subject: string; level: string; message: string; opened_at: string; last_seen_at: string; resolved_at: string | null; notified: boolean }[]
  thresholds: { lowMemoryMb: number; buildMinFreeMb: number; buildConcurrency: number }
}

const gb = (mb: number | null | undefined) => mb === null || mb === undefined ? '—' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// Well-known programs that are not apps, explained for people who did not start them.
const KNOWN: Record<string, string> = {
  claude: 'Claude desktop app open on this server',
  mysqld: 'MySQL database server',
  postgres: 'PostgreSQL database servers',
  MsMpEng: 'Windows Defender antivirus',
  svchost: 'Windows services',
  explorer: 'Windows desktop and File Explorer',
  node: 'Node.js processes outside PM2',
  caddy: 'Caddy web server',
  'caddy-service': 'Caddy web server',
  msedgewebview2: 'Embedded browser used by desktop apps',
  php: 'PHP processes',
  powershell: 'PowerShell sessions',
}

function Meter({ used, total, warnAt, label }: { used: number; total: number; warnAt?: number; label: string }) {
  const share = total > 0 ? Math.min(1, used / total) : 0
  const tone = warnAt !== undefined && total - used < warnAt ? 'bg-status-failed' : share > 0.8 ? 'bg-status-building' : 'bg-status-ready'
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used} className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
      <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  )
}

/** Free memory over the last day, with the warning line drawn in. */
function FreeMemoryChart({ history, totalMb, lowMb }: { history: Overview['history']; totalMb: number; lowMb: number }) {
  if (history.length < 2) return <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">History builds up once a minute. Check back shortly.</p>
  const width = 720, height = 140
  const start = Date.parse(history[0].takenAt), end = Date.parse(history[history.length - 1].takenAt)
  const x = (iso: string) => ((Date.parse(iso) - start) / Math.max(1, end - start)) * width
  const y = (mb: number) => height - (Math.max(0, Math.min(totalMb, mb)) / totalMb) * height
  const line = history.map((point, index) => `${index ? 'L' : 'M'}${x(point.takenAt).toFixed(1)},${y(point.availableMb).toFixed(1)}`).join(' ')
  const lowest = history.reduce((low, point) => point.availableMb < low.availableMb ? point : low)
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full" preserveAspectRatio="none" role="img" aria-label={`Free memory over the last day; lowest ${gb(lowest.availableMb)} at ${when(lowest.takenAt)}`}>
        <rect x="0" y={y(lowMb)} width={width} height={height - y(lowMb)} className="fill-status-failed/10" />
        <line x1="0" x2={width} y1={y(lowMb)} y2={y(lowMb)} className="stroke-status-failed/50" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={`${line} L${width},${height} L0,${height} Z`} className="fill-syn-cyan/10" />
        <path d={line} fill="none" className="stroke-syn-cyan" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{when(history[0].takenAt)}</span>
        <span>Lowest: <span className="text-foreground">{gb(lowest.availableMb)}</span> at {when(lowest.takenAt)} · shaded area is below the {gb(lowMb)} warning line</span>
        <span>now</span>
      </figcaption>
    </figure>
  )
}

export default function MemoryPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    void fetch('/api/server/memory', { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read memory')
      setData(body); setError('')
    }).catch(err => setError((err as Error).message)).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const snapshot = data?.snapshot
  const appsTotal = useMemo(() => snapshot?.apps.reduce((sum, app) => sum + app.privateMb, 0) ?? 0, [snapshot])
  const staging = useMemo(() => snapshot?.apps.filter(app => app.environment === 'staging') ?? [], [snapshot])
  const openAlerts = data?.alerts.filter(alert => !alert.resolved_at) ?? []
  const recentAlerts = data?.alerts.filter(alert => alert.resolved_at) ?? []
  const apps = showAll ? snapshot?.apps ?? [] : (snapshot?.apps ?? []).slice(0, 12)
  const largest = snapshot?.apps[0]?.privateMb || 1

  return (
    <AppShell title="Memory" subtitle="What is using this server's memory, how it changed over the last day, and warnings before it runs out." area="infrastructure"
      back={{ href: '/infrastructure', label: 'Infrastructure' }}
      actions={<Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</Button>}>
      {error && <div role="alert" className="notice-error">{error}</div>}
      {!snapshot && !error && <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />}

      {snapshot && data && <div className="space-y-6">
        {openAlerts.length > 0 && <div className="space-y-2">
          {openAlerts.map(alert => (
            <div key={alert.id} role="alert" className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', alert.level === 'error' ? 'border-status-failed/40 bg-status-failed/[0.06] text-red-100' : 'border-status-building/40 bg-status-building/[0.06] text-amber-100')}>
              <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', alert.level === 'error' ? 'text-status-failed' : 'text-status-building')} />
              <div className="min-w-0 flex-1">
                <p>{alert.message}</p>
                <p className="mt-0.5 text-xs opacity-70">Since {when(alert.opened_at)}{alert.notified ? ' · notification sent' : ' · no notification channel set up (Settings › Notifications)'}</p>
              </div>
            </div>
          ))}
        </div>}

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="eyebrow">Free memory</p>
            <p className="text-2xl font-semibold tracking-tight">{gb(snapshot.availableMb)} <span className="text-sm font-normal text-muted-foreground">of {gb(snapshot.totalMb)}</span></p>
            <div className="mt-3"><Meter used={snapshot.totalMb - snapshot.availableMb} total={snapshot.totalMb} warnAt={data.thresholds.lowMemoryMb} label="Memory in use" /></div>
            <p className="mt-2 text-xs text-muted-foreground">{gb(snapshot.totalMb - snapshot.availableMb)} in use. A warning is raised below {gb(data.thresholds.lowMemoryMb)} free.</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="eyebrow">Promised to programs</p>
            <p className="text-2xl font-semibold tracking-tight">{gb(snapshot.commitMb)} <span className="text-sm font-normal text-muted-foreground">of {gb(snapshot.commitLimitMb)}</span></p>
            {snapshot.commitMb !== null && snapshot.commitLimitMb ? <div className="mt-3"><Meter used={snapshot.commitMb} total={snapshot.commitLimitMb} warnAt={snapshot.commitLimitMb * 0.1} label="Memory promised to programs" /></div> : null}
            <p className="mt-2 text-xs text-muted-foreground">Memory plus page file. When this reaches the limit, programs crash. Page file: {gb(snapshot.pageFileUsedMb)} used of {gb(snapshot.pageFileMb)}.</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="eyebrow">Deployments</p>
            <p className="text-2xl font-semibold tracking-tight">{data.thresholds.buildConcurrency} build{data.thresholds.buildConcurrency === 1 ? '' : 's'} <span className="text-sm font-normal text-muted-foreground">at a time</span></p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">A build waits until at least {gb(data.thresholds.buildMinFreeMb)} is free, so deployments cannot starve running apps. The live app stays online while it waits.</p>
          </div>
        </section>

        <Section title="Free memory, last 24 hours" description="Sampled every minute. Dips usually line up with deployments or a busy app.">
          <FreeMemoryChart history={data.history} totalMb={snapshot.totalMb} lowMb={data.thresholds.lowMemoryMb} />
        </Section>

        <Section title="Apps" description={<>Your apps use {gb(appsTotal)} in total. Each figure covers the app&apos;s whole process tree, including the processes that start it.{staging.length > 0 && <> {staging.length} staging app{staging.length === 1 ? '' : 's'} use{staging.length === 1 ? 's' : ''} {gb(staging.reduce((sum, app) => sum + app.privateMb, 0))}.</>}</>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">App</th><th className="py-2 pr-3 font-medium">Now</th><th className="w-[30%] py-2 pr-3 font-medium"><span className="sr-only">Share</span></th>
                <th className="py-2 pr-3 font-medium">Peak, 24 h</th><th className="py-2 pr-3 font-medium">Limit</th><th className="py-2 font-medium"><span className="sr-only">Open</span></th>
              </tr></thead>
              <tbody>
                {apps.map(app => {
                  const over = app.limitMb !== null && app.privateMb > app.limitMb
                  return (
                    <tr key={app.name} className="border-b border-border/60 last:border-0">
                      <td className="py-2.5 pr-3">
                        <span className="block truncate font-medium">{app.label}</span>
                        <span className="block text-xs text-muted-foreground">{app.environment === 'staging' ? 'Staging · ' : ''}{app.processes} process{app.processes === 1 ? '' : 'es'}</span>
                      </td>
                      <td className={cn('py-2.5 pr-3 font-mono', over && 'text-red-300')}>{gb(app.privateMb)}</td>
                      <td className="py-2.5 pr-3"><div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className={cn('h-full rounded-full', over ? 'bg-status-failed' : 'bg-syn-cyan/70')} style={{ width: `${Math.max(2, Math.round(app.privateMb / largest * 100))}%` }} /></div></td>
                      <td className="py-2.5 pr-3 font-mono text-muted-foreground">{gb(app.peakMb)}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{app.limitMb ? <span className="font-mono">{gb(app.limitMb)}</span> : 'None'}</td>
                      <td className="py-2.5 text-right">{app.projectId && <Link href={`/sites/${app.projectId}?tab=settings#memory`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">{app.limitMb ? 'Change' : 'Set limit'}<ArrowUpRight className="h-3 w-3" /></Link>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(snapshot.apps.length > 12) && <Button variant="ghost" size="sm" className="mt-3" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show fewer' : `Show all ${snapshot.apps.length} apps`}</Button>}
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />A limit caps a Node.js app&apos;s heap, so a leak restarts that one app instead of starving the server. Synergy also warns when an app goes over its limit or keeps growing for hours.</p>
        </Section>

        <Section title="Everything else" description="Programs on this server that are not apps managed here.">
          <ul className="divide-y divide-border/60 text-sm">
            {snapshot.others.map(item => (
              <li key={item.name} className="flex items-center justify-between gap-4 py-2.5">
                <span className="min-w-0"><span className="block truncate font-medium">{KNOWN[item.name] || item.name}</span><span className="block text-xs text-muted-foreground">{item.name}{item.count > 1 ? ` · ${item.count} processes` : ''}</span></span>
                <span className="shrink-0 font-mono">{gb(item.privateMb)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Recent warnings" description="Closed warnings from the last seven days. A warning closes once its condition has been clear for 15 minutes.">
          {recentAlerts.length === 0
            ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-status-ready" />No memory warnings in the last seven days.</p>
            : <ul className="divide-y divide-border/60 text-sm">{recentAlerts.map(alert => (
              <li key={alert.id} className="py-2.5"><p>{alert.message}</p><p className="text-xs text-muted-foreground">{when(alert.opened_at)} to {when(alert.resolved_at!)}</p></li>
            ))}</ul>}
        </Section>

        <p className="text-xs text-muted-foreground">Measured {when(snapshot.takenAt)}. Updates every 30 seconds while this page is open.</p>
      </div>}
    </AppShell>
  )
}
