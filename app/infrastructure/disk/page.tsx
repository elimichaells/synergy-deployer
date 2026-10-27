'use client'

import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import type { CleanupReport } from '@/lib/release-cleanup'

type Run = { id: string; mode: string; source: string; status: string; started_at: string; finished_at: string | null; report: Partial<CleanupReport> }
type Data = { enabled: boolean; role: string; history: Run[]; volumes: { path: string; locations: string[]; free: number | null; total: number | null }[] }
const bytes = (n: number | null | undefined) => n === null || n === undefined ? 'Unavailable' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`
const panel = 'rounded-xl border border-border bg-card p-5'
const button = 'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'

export default function DiskPage() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/system/release-cleanup', { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw Error(result.error || 'Storage information could not be loaded')
      setData(result)
    } catch (e) { setError((e as Error).message) }
  }, [])
  const running = data?.history[0]?.status === 'running'
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), running ? 3000 : 30000); return () => clearInterval(timer) }, [refresh, running])
  async function action(action: string, enabled?: boolean) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/system/release-cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, enabled }) })
      const result = await response.json()
      if (!response.ok) throw Error(result.error || 'Storage operation could not be started')
      await refresh()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  const latest = data?.history.find(run => run.status !== 'running' && run.report.projects)
  const report = latest?.report
  const admin = data?.role === 'admin'
  const entries = (report?.projects || []).flatMap(project => project.entries.map(entry => ({ ...entry, projectName: project.projectName })))
  return <AppShell title="Disk cleanup" subtitle="Reclaim expired deployment files while keeping recent releases and recovery copies." area="infrastructure" back={{ href: '/infrastructure', label: 'Infrastructure' }}
    actions={<button className={button} disabled={busy} onClick={() => { setError(''); void refresh() }}><RefreshCw className="h-4 w-4" />Refresh</button>}>
    <div className="space-y-6">
      {error && <div role="alert" className="notice-error">{error}</div>}
      {!data ? <p className="text-sm text-muted-foreground">Loading disk information…</p> : <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{data.volumes.map(volume => <div key={volume.path} className={panel}>
          <HardDrive className="mb-3 h-5 w-5 text-syn-cyan" /><p className="text-xl font-semibold">{bytes(volume.free)} free</p>
          <p className="mt-1 text-xs text-muted-foreground">of {bytes(volume.total)}</p><p className="mt-3 break-all font-mono text-xs text-muted-foreground">{volume.locations.join(' · ')}</p>
        </div>)}</div>
        <section className={panel} aria-label="Automatic cleanup">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold">Automatic cleanup</h2><p className="mt-1 text-sm text-muted-foreground">Checks once a day while Manager is running. Busy applications are skipped until a later run.</p></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-white" checked={data.enabled} disabled={!admin || busy || running} onChange={event => void action('settings', event.target.checked)} />Enabled</label></div>
          <div className="mt-5 flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" /><div className="space-y-2 text-sm text-muted-foreground">
            <p>Keeps the current deployment and the latest three successful deployment workspaces. Other successful releases stay for at least seven days; failed builds stay for three days.</p>
            <p>Keeps the newest dependency snapshot; older caches expire after seven days. Active processes, scheduled jobs, pinned folders and interrupted recovery protect their files.</p>
            <p>Live application directories, uploads, environment files in the live app, databases, backups and Manager update recovery files are outside this cleanup. Deployment history and logs remain available.</p>
          </div></div>
        </section>
        <section className={panel} aria-label="Cleanup preview">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Release storage</h2><p className="mt-1 text-sm text-muted-foreground">Scans production, staging and custom application locations on this Manager host.</p></div>
            <div className="flex flex-wrap gap-2"><button className={button} disabled={!admin || busy || running} onClick={() => void action('scan')}><RefreshCw className="h-4 w-4" />Scan storage</button>
              <button className={button} disabled={!admin || busy || running || !entries.some(e => e.eligible) || latest?.mode !== 'scan'} onClick={() => void action('clean')}><Trash2 className="h-4 w-4" />Clean expired files</button></div></div>
          {running && <p role="status" className="mt-4 text-sm text-syn-cyan">{data.history[0].report.progress || 'Inspecting storage…'} Large release folders can take a few minutes.</p>}
          {!report ? <p className="mt-5 text-sm text-muted-foreground">Scan to see folder sizes and which copies can be removed.</p> : <>
            <div className="my-5 grid gap-3 sm:grid-cols-3">{[['Eligible in scan', bytes(report.eligibleBytes)], ['Protected in scan', bytes(report.retainedBytes)], ['Files removed', bytes(report.removedBytes)]].map(([label, value]) => <div key={label} className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold">{value}</p></div>)}</div>
            <p className="mb-4 text-xs text-muted-foreground">{latest && new Date(latest.started_at).toLocaleString()} · Sizes are estimates; shared files and concurrent disk activity can change the space recovered. Cleanup rechecks protection immediately before removal.</p>
            {[...(report.warnings || []), ...(report.projects || []).flatMap(p => p.warnings.map(w => `${p.projectName}: ${w}`))].map((warning, i) => <p key={i} className="mb-2 text-sm text-amber-200">{warning}</p>)}
            {!entries.length ? <p className="text-sm text-muted-foreground">No eligible release directories were found.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="py-2 pr-4">Application / folder</th><th className="py-2 pr-4">Size</th><th className="py-2">Decision</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.path} className="border-t border-border"><td className="py-3 pr-4"><p>{entry.projectName}</p><p className="mt-1 max-w-md break-all font-mono text-xs text-muted-foreground" title={entry.path}>{entry.name}</p></td><td className="whitespace-nowrap py-3 pr-4">{bytes(entry.bytes)}</td><td className="py-3"><p className={entry.eligible ? 'text-amber-200' : 'text-emerald-300'}>{report.removed?.some(r => r.path === entry.path && !r.partial) ? 'Removed' : entry.eligible ? 'Eligible' : 'Keep'}</p><p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p></td></tr>)}</tbody></table></div>}
          </>}
        </section>
        <section className={panel}><h2 className="font-semibold">Recent activity</h2><div className="mt-3 space-y-3">{data.history.length ? data.history.map(run => <div key={run.id} className="flex flex-wrap justify-between gap-2 border-t border-border pt-3 text-sm"><span>{run.mode === 'clean' ? 'Cleanup' : 'Scan'} · {run.source} · {run.status.replaceAll('_', ' ')}</span><span className="text-muted-foreground">{new Date(run.started_at).toLocaleString()} · {bytes(run.report.removedBytes || 0)} removed</span></div>) : <p className="text-sm text-muted-foreground">No scans or cleanups yet.</p>}</div></section>
      </>}
    </div>
  </AppShell>
}
