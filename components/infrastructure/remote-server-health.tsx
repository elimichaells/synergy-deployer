import { Section } from '@/components/app/section'
import { ResourceUsage } from '@/components/workspace/resource-usage'
import type { ManagedServer, RemoteApp } from '@/lib/managed-server-types'
import { remoteAppHref } from '@/lib/remote-workspace'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'

export function RemoteServerHealth({ server, apps, fresh }: { server: ManagedServer; apps: RemoteApp[]; fresh: boolean }) {
  const metrics = server.metrics
  if (!metrics) return <Section title="Health & alerts" description="Connect this server to receive health and resource reports." />
  const running = metrics.apps.filter(process => process.status === 'online' && apps.some(app => app.id === process.id)).length
  return <div className="space-y-6">
    <div className="rounded-xl border border-border bg-card p-5"><div className="flex items-center gap-2 font-medium">{!fresh || metrics.proxyError ? <AlertTriangle className="h-5 w-5 text-amber-300" /> : <CheckCircle2 className="h-5 w-5 text-status-ready" />}{fresh ? 'Receiving server reports' : 'Monitoring unavailable'}</div><p className="mt-2 text-sm text-muted-foreground">Last report: {server.last_seen_at ? new Date(server.last_seen_at).toLocaleString() : 'Not received'}. {fresh ? `${running} application processes running.` : 'Values below are from the last report.'}</p><p className="mt-2 text-xs text-muted-foreground">{metrics.hostname} · {metrics.addresses.join(', ')} · uptime {(metrics.uptime / 86400).toFixed(1)} days</p><p className="mt-2 text-xs text-muted-foreground">HTTP readiness is checked during deployment. Continuous readiness checks and alert history are not reported by this agent.</p></div>
    <ResourceUsage cpu={metrics.cpuPercent} memoryFree={metrics.memoryFree} memoryTotal={metrics.memoryTotal} disks={metrics.diskFree !== null && metrics.diskTotal !== null ? [{ name: 'Application disk', free: metrics.diskFree, total: metrics.diskTotal }] : []} processHint={fresh ? `${running} processes online` : 'Process health unknown'} />
    {metrics.diskFree === null && <p className="text-xs text-muted-foreground">Disk capacity has not been reported by this server.</p>}
    <RemoteProcesses server={server} apps={apps} fresh={fresh} />
  </div>
}

export function RemoteProcesses({ server, apps, fresh }: { server: ManagedServer; apps: RemoteApp[]; fresh: boolean }) {
  return <Section title="Application processes" description="Process status and resource usage from this server's latest report."><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-xs text-muted-foreground"><th className="px-4 py-3">Application</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">CPU</th><th className="px-4 py-3">Memory</th></tr></thead><tbody>{apps.map(app => { const process = server.metrics?.apps.find(item => item.id === app.id); return <tr key={app.id} className="border-t border-border/60"><td className="px-4 py-3"><Link className="font-medium hover:underline" href={remoteAppHref(server.id, app.id)}>{app.name}</Link></td><td className="px-4 py-3">{fresh ? process?.status || 'Not running' : 'Unknown'}</td><td className="px-4 py-3">{fresh && process ? `${process.cpu.toFixed(0)}%` : '—'}</td><td className="px-4 py-3">{fresh && process ? `${(process.memory / 1024 ** 2).toFixed(0)} MB` : '—'}</td></tr> })}</tbody></table>{!apps.length && <p className="py-8 text-center text-sm text-muted-foreground">No application processes yet.</p>}</div></Section>
}
