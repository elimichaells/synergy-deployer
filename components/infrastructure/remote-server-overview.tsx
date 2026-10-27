'use client'

import Link from 'next/link'
import { ArrowRight, Boxes, Cpu, HardDrive, MemoryStick, Plus, Rocket, ShieldCheck } from 'lucide-react'
import { relativeTime } from '@/lib/deployment-stages'
import { remoteOverview } from '@/lib/remote-server-overview'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'

export const remoteJobLabels: Record<RemoteJob['status'], string> = { success: 'Ready', failed: 'Failed', running: 'Deploying', queued: 'Queued', cancelled: 'Cancelled' }
export const remoteJobTone: Record<RemoteJob['status'], string> = { success: 'text-status-ready', failed: 'text-status-failed', running: 'text-status-building', queued: 'text-status-building', cancelled: 'text-muted-foreground' }
export const remoteGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

export function RemoteServerOverview({ server, apps, jobs, now, loadError, canCreate, onCreate }: {
  server: ManagedServer; apps: RemoteApp[]; jobs: RemoteJob[]; now: number; loadError: boolean; canCreate: boolean; onCreate: () => void
}) {
  const summary = remoteOverview(server, apps, jobs, now, loadError)
  const root = `/infrastructure/servers/${server.id}`
  const metrics = server.metrics
  const stats = [
    ['Applications', String(summary.apps.length), summary.running === null ? 'Awaiting current process status' : `${summary.running} ${summary.running === 1 ? 'process' : 'processes'} running`],
    ['Deploying', String(summary.active.length), 'queued or running in recent activity'],
    ['Success rate', summary.successRate === null ? '—' : `${summary.successRate}%`, 'recent completed deployments'],
    ['Needs attention', String(summary.failed), 'latest reported releases failed'],
  ]
  return <div className="space-y-6">
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2.5 text-sm font-semibold"><span className={`h-2 w-2 rounded-full ${summary.active.length ? 'spectrum-flow' : summary.fresh ? 'bg-status-ready' : 'bg-status-building'}`} />{summary.active.length ? `${summary.active.length} deployment${summary.active.length === 1 ? '' : 's'} in progress` : 'Recent deployment activity'}</h2>
        <span className="text-xs text-muted-foreground">{summary.lastRelease ? `Last release ${relativeTime(summary.lastRelease.finished_at, now)} · ${summary.lastRelease.app_name}` : 'No successful releases yet'}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4">{stats.map(([label, value, hint], index) => <div key={label} data-tone={index % 3} className={`metric-tile px-5 py-4 ${index % 2 ? 'border-l border-border' : ''} ${index > 1 ? 'border-t border-border md:border-t-0' : ''} ${index === 2 ? 'md:border-l' : ''}`}>
        <p className="text-xs text-muted-foreground">{label}</p><p className={`mt-1 text-2xl font-semibold tracking-tight ${index === 3 && summary.failed ? 'text-status-failed' : ''}`}>{value}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
      </div>)}</div>
    </section>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(280px,1fr)]">
      <div className="min-w-0 space-y-6">
        <section>
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Recent deployments</h2><Link href={`${root}#deployments`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">View history<ArrowRight className="h-3.5 w-3.5" /></Link></div>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {!summary.jobs.length && <div className="px-6 py-12 text-center"><Rocket className="mx-auto mb-3 h-6 w-6 text-muted-foreground" /><p className="text-sm font-medium">No deployments yet</p><p className="mt-1 text-xs text-muted-foreground">Your releases and build output will appear here.</p></div>}
            {summary.jobs.slice(0, 6).map(job => <Link key={job.id} href={`${root}?view=${job.id}#deployments`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
              <span className={`h-2 w-2 shrink-0 rounded-full bg-current ${remoteJobTone[job.status]}`} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{job.app_name}</span><span className="block truncate text-[11px] text-muted-foreground">{job.commit_sha?.slice(0, 7) || 'Awaiting commit'} · {relativeTime(job.created_at, now)}</span></span>
              <span className={`text-xs ${remoteJobTone[job.status]}`}>{remoteJobLabels[job.status]}</span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
            </Link>)}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Statistics use this server’s latest 30 deployment records. Running processes are reported by its agent.</p>
        </section>
        <section>
          <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Server health</h2><span className="text-[11px] text-muted-foreground">{summary.fresh ? 'Live agent report' : metrics ? 'Last reported values' : 'Awaiting first heartbeat'}</span></div>
          <div className="grid gap-3 sm:grid-cols-3">{[
            { name: 'CPU', icon: Cpu, value: metrics ? `${metrics.cpuPercent.toFixed(0)}%` : '—', hint: 'processor usage', percent: metrics?.cpuPercent },
            { name: 'Memory', icon: MemoryStick, value: metrics ? remoteGb(metrics.memoryFree) : '—', hint: metrics ? `free of ${remoteGb(metrics.memoryTotal)}` : 'waiting for agent', percent: metrics && metrics.memoryTotal > 0 ? 100 * (1 - metrics.memoryFree / metrics.memoryTotal) : undefined },
            { name: 'Disk', icon: HardDrive, value: metrics?.diskFree != null ? remoteGb(metrics.diskFree) : '—', hint: metrics?.diskTotal ? `free of ${remoteGb(metrics.diskTotal)}` : 'not reported', percent: metrics?.diskTotal && metrics.diskFree != null ? 100 * (1 - metrics.diskFree / metrics.diskTotal) : undefined },
          ].map((metric, index) => <div key={metric.name} data-tone={index} className="metric-tile rounded-xl border border-border bg-card p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><metric.icon className="h-3.5 w-3.5" />{metric.name}</p><p className="mt-2 text-lg font-semibold">{metric.value}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{metric.hint}</p><div className="mt-3 h-1 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${!summary.fresh ? 'bg-muted-foreground/40' : (metric.percent || 0) >= 90 ? 'bg-status-building' : 'bg-primary/70'}`} style={{ width: `${Math.max(0, Math.min(100, metric.percent || 0))}%` }} /></div></div>)}</div>
        </section>
      </div>
      <aside className="min-w-0 space-y-6">
        <section><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Applications</h2><Link href={`${root}#applications`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">View all<ArrowRight className="h-3.5 w-3.5" /></Link></div>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {!summary.apps.length && <p className="px-5 py-10 text-center text-sm text-muted-foreground">No applications yet.</p>}
            {summary.apps.slice(0, 7).map(app => {
              const status = metrics?.apps.find(process => process.id === app.id)?.status
              return <Link key={app.id} href={`${root}#app-${app.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Boxes className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{app.name}</span><span className="block truncate text-[11px] text-muted-foreground">{app.environment_name ? `${app.environment_name} · ` : ''}{app.hostname.endsWith('.invalid') ? 'Setup required' : app.hostname}</span></span><span className={`text-[11px] ${summary.fresh && status === 'online' ? 'text-status-ready' : 'text-muted-foreground'}`}>{!summary.fresh ? 'Unknown' : status === 'online' ? 'Running' : status || 'Not deployed'}</span></Link>
            })}
          </div>
        </section>
        <section><h2 className="mb-3 text-sm font-semibold">Shortcuts</h2><div className="grid gap-2">
          {canCreate && <button onClick={onCreate} className="syn-tile flex items-center gap-3 px-4 py-3 text-left"><Plus className="h-4 w-4 text-primary" /><span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">Import a repository</span><span className="block text-[11px] text-muted-foreground">Deploy a new app on {server.name}</span></span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></button>}
          <Link href={`${root}#server-access`} className="syn-tile flex items-center gap-3 px-4 py-3"><ShieldCheck className="h-4 w-4 text-primary" /><span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">Server access & HTTPS</span><span className="block text-[11px] text-muted-foreground">Connection, runtimes and LAN trust</span></span><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></Link>
        </div></section>
      </aside>
    </div>
  </div>
}
