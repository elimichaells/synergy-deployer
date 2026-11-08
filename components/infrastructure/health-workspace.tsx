'use client'

import Link from 'next/link'
import type { ServerHealth } from '@/lib/server-health-types'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ResourceUsage } from '@/components/workspace/resource-usage'
import { HealthHistoryPanel } from '@/components/health-history'

const when = (value: string) => new Date(value).toLocaleString()

export function HealthWorkspace({health,error,remoteEndpoint}:{health:ServerHealth|null;error:boolean;remoteEndpoint?:string}) {
  const open = health?.incidents.filter(x => !x.resolvedAt) || []
  const resolved = health?.incidents.filter(x => x.resolvedAt) || []
  const sample = health?.snapshot
  return <>
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 font-medium">{error || health?.stale || open.length ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-status-ready" />}
          {error || health?.unavailable ? 'Monitoring unavailable' : !health ? 'Loading checks…' : health.stale ? 'Checks are overdue' : open.length ? `${open.length} active alert${open.length === 1 ? '' : 's'}` : 'No active alerts'}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{health?.checkedAt ? `Last check: ${when(health.checkedAt)}. ` : ''}Checks run every minute, independently of the application processes. This page refreshes every 30 seconds.</p>
        {(error || health?.unavailable || health?.stale) && <p className="mt-2 text-sm text-amber-200">Current server health is unknown. {remoteEndpoint ? 'Check the agent connection and install the current agent from Agent access & updates.' : 'Check the Manager Server Monitor task in Windows Task Scheduler.'}</p>}
        <p className="mt-2 text-xs text-muted-foreground">Alerts appear inside this manager. If the manager is unreachable, view recorded incidents after access returns.</p>
        <p className="mt-2 text-xs text-muted-foreground">Manager {process.env.NEXT_PUBLIC_MANAGER_VERSION}{process.env.NEXT_PUBLIC_MANAGER_COMMIT ? ` · release ${process.env.NEXT_PUBLIC_MANAGER_COMMIT.slice(0, 8)}` : ' · development build'}</p>
      </div>
      {open.length > 0 && <section aria-label="Active alerts" className="space-y-3">{open.map(alert => <div key={alert.id} className={`rounded-lg border p-4 ${alert.severity === 'critical' ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
        <p className="text-xs font-semibold uppercase tracking-wide">{alert.severity} · {alert.source || 'Server'}</p><p className="mt-1 text-sm font-medium">{alert.message}</p>
        {(alert.service || alert.dependency) && <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {alert.service && <div><dt className="text-muted-foreground">Affected service</dt><dd className="mt-1 break-words font-medium">{alert.service}</dd></div>}
          {alert.dependency && <div><dt className="text-muted-foreground">Failing check</dt><dd className="mt-1 font-medium">{alert.dependency}</dd></div>}
          {alert.endpoint && <div><dt className="text-muted-foreground">Readiness endpoint</dt><dd className="mt-1 break-all font-mono">{alert.endpoint}</dd></div>}
          {alert.observed && <div><dt className="text-muted-foreground">Observed / expected</dt><dd className="mt-1">{alert.observed} / {alert.expected || 'successful response'}{alert.responseMs !== undefined && <span className="text-muted-foreground"> · {alert.responseMs} ms</span>}</dd></div>}
        </dl>}
        <p className="mt-3 text-sm text-muted-foreground"><span className="font-medium text-foreground">Next step: </span>{alert.action}</p>{alert.href && <Link href={alert.href} className="mt-2 inline-block text-xs underline">Inspect {alert.service || alert.source || 'server'}</Link>}<p className="mt-2 text-xs text-muted-foreground">First observed {when(alert.openedAt)} · last confirmed {when(alert.lastSeenAt)}</p>
      </div>)}</section>}
      <HealthHistoryPanel endpoint={remoteEndpoint ? remoteEndpoint+'/history' : undefined} />
      {!remoteEndpoint && <Link href="/infrastructure/operations" className="block rounded-xl border border-border bg-card p-5 text-sm"><span className="font-semibold">AI Operations →</span><span className="mt-1 block text-muted-foreground">Investigate these alerts, review application recovery and inspect sampled uptime.</span></Link>}
      {sample && <ResourceUsage disks={sample.disks} memoryFree={sample.memory.free} processHint={`${sample.apps.filter(x => x.status === 'online').length} processes online · ${sample.pm2Updates} PM2 update processes`} />}
      {sample && <section className="overflow-hidden rounded-xl border border-border"><div className="border-b border-border p-4"><h2 className="font-medium">Service responses</h2><p className="mt-1 text-xs text-muted-foreground">Readiness checks follow local redirects and require a successful response or the app’s configured expected code. A running process alone does not establish readiness.</p></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-xs text-muted-foreground"><th className="px-4 py-3">Service</th><th className="px-4 py-3">Response</th><th className="px-4 py-3 text-right">Time</th></tr></thead><tbody>{sample.checks.map(check => <tr key={check.name} className="border-t border-border/60"><td className="px-4 py-3">{check.name}</td><td className={`px-4 py-3 ${check.ok ? 'text-status-ready' : 'text-red-300'}`}>{check.status ? `HTTP ${check.status}` : 'No response'}{check.reason && <p className="mt-1 text-xs text-muted-foreground">{check.reason}</p>}</td><td className="px-4 py-3 text-right tabular-nums">{check.ms} ms</td></tr>)}</tbody></table></div></section>}
      <section className="rounded-xl border border-border p-5"><h2 className="font-medium">When warnings appear</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground"><li>Disk: warning below 20% or 30 GB free; critical below 10% or 15 GB. Rapid growth also warns when estimated time to full is under six hours.</li><li>Memory: low free memory for three checks. Services: two failed or slow checks in a row.</li><li>Processes: missing applications, repeated restarts, or multiple PM2 updates. Critical update storms and critical disk space alert immediately.</li><li>Logs: active log files over 100 MB, critical at 500 MB. Incidents resolve after two healthy checks.</li></ul></section>
      <section className="rounded-xl border border-border p-5"><h2 className="font-medium">Recent resolved incidents</h2>{!resolved.length ? <p className="mt-3 text-sm text-muted-foreground">No resolved incidents recorded yet.</p> : <ul className="mt-3 divide-y divide-border">{resolved.map(alert => <li key={alert.id} className="py-3 text-sm"><p>{alert.message}</p><p className="mt-1 text-xs text-muted-foreground">{when(alert.openedAt)} → {when(alert.resolvedAt!)}</p></li>)}</ul>}</section>
    </div>
  </>
}
