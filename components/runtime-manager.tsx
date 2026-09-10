'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUp, CheckCircle2, Download, Eye, Layers3, Loader2, RefreshCw, Search, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { runtimeCategory } from '@/lib/settings-workspace'

type JobAction = 'install' | 'update' | 'configure' | 'install-version'
interface RuntimeJob { id: string; runtime_id: string; action: JobAction; requested_version: string | null; status: 'queued' | 'running' | 'success' | 'failed' | 'interrupted'; log: string; error: string | null; created_at: string }
interface RuntimeStatus {
  id: string
  name: string
  purpose: string
  installed: boolean
  version: string | null
  canInstall: boolean
  canUpdate: boolean
  canConfigure: boolean
  versioned: boolean
  installedVersions: string[]
  updateAvailable: boolean
  latestVersion: string | null
  updateRisk: 'major' | 'minor' | 'patch' | null
  updateCheckedAt: string | null
  activeJob: RuntimeJob | null
  latestJob: RuntimeJob | null
}
interface VersionOption { version: string; label: string; date?: string }

export function RuntimeManager({ isAdmin, runtimeIds, workspace = false, onChanged }: { isAdmin: boolean; runtimeIds?: string[]; workspace?: boolean; onChanged?: () => void | Promise<void> }) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [job, setJob] = useState<RuntimeJob | null>(null)
  const [versionRuntime, setVersionRuntime] = useState<RuntimeStatus | null>(null)
  const [versions, setVersions] = useState<VersionOption[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const streamRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/system/runtimes', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Failed to inspect runtimes')
      setRuntimes(body.runtimes || [])
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Failed to inspect runtimes') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => streamRef.current?.close(), [])
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [job?.log])

  const watchJob = (nextJob: RuntimeJob) => {
    streamRef.current?.close()
    setJob(nextJob)
    if (!['queued', 'running'].includes(nextJob.status)) return
    const stream = new EventSource(`/api/system/runtimes/jobs/${nextJob.id}/stream`)
    streamRef.current = stream
    stream.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { job: RuntimeJob }
      setJob(payload.job)
      if (!['queued', 'running'].includes(payload.job.status)) {
        stream.close(); streamRef.current = null
        setMessage(payload.job.status === 'success'
          ? payload.job.runtime_id === 'mysql' && payload.job.action === 'configure' ? 'MySQL service and provisioning credential are healthy.' : 'Host dependency operation completed successfully.'
          : payload.job.error || 'Host dependency operation failed.')
        void load()
        if (payload.job.status === 'success') void onChanged?.()
      }
    }
  }

  const startJob = async (runtime: RuntimeStatus, action: JobAction, version?: string) => {
    setMessage(null)
    try {
      const response = await fetch('/api/system/runtimes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: runtime.id, action, version }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `${runtime.name} operation failed to start`)
      if (action === 'install-version') setVersionRuntime(null)
      watchJob(body.job)
      await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : `${runtime.name} operation failed to start`) }
  }

  const checkUpdates = async () => {
    setChecking(true); setMessage(null)
    try {
      const response = await fetch('/api/system/runtimes/check-updates', { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Update check failed')
      setRuntimes(body.runtimes || [])
      const count = (body.runtimes || []).filter((runtime: RuntimeStatus) => runtime.updateAvailable).length
      setMessage(count ? `${count} host dependenc${count === 1 ? 'y has' : 'ies have'} an update available.` : 'Host dependencies are current.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Update check failed') }
    finally { setChecking(false) }
  }

  const openVersions = async (runtime: RuntimeStatus) => {
    setVersionRuntime(runtime); setVersionsLoading(true); setVersions([])
    try {
      const response = await fetch(`/api/system/runtimes/versions?runtime=${encodeURIComponent(runtime.id)}`, { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Version catalog could not be loaded')
      setVersions(body.available || [])
      setVersionRuntime((current) => current ? { ...current, installedVersions: body.installed || [] } : current)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Version catalog could not be loaded') }
    finally { setVersionsLoading(false) }
  }

  const anyActive = runtimes.some((runtime) => runtime.activeJob)
  const available = runtimes.filter(runtime => !runtimeIds || runtimeIds.includes(runtime.id))
  const updateCount = available.filter(runtime => runtime.updateAvailable).length
  const shown = available.filter(runtime => !workspace || (
    `${runtime.name} ${runtime.purpose}`.toLowerCase().includes(search.toLowerCase()) &&
    (category === 'all' || runtimeCategory(runtime.id) === category) &&
    (status === 'all' || (status === 'installed' && runtime.installed) || (status === 'missing' && !runtime.installed) || (status === 'updates' && runtime.updateAvailable))
  ))
  const jobTitle = job?.runtime_id === 'mysql' && job.action === 'configure' ? 'MySQL provisioning setup' : job ? `${job.runtime_id} ${job.action}` : 'Host dependency operation'
  const jobStatus = job?.status === 'success' ? 'Completed successfully' : job?.status
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-medium">{workspace ? `${available.filter(runtime => runtime.installed).length} installed / ${available.length} dependencies` : 'Host dependencies'}</p><p className="mt-1 text-xs text-muted-foreground">{updateCount} update{updateCount === 1 ? '' : 's'} available{anyActive ? ' / Operation in progress' : ''}</p></div>
        <div className="flex flex-wrap gap-1">
          {isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => void checkUpdates()} disabled={checking || anyActive}>{checking ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}Check updates</Button>}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void load()} disabled={loading} title="Refresh runtimes" aria-label="Refresh runtimes"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>
      {workspace && <div className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_160px_150px]">
        <div className="relative min-w-0"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input aria-label="Search runtimes" className="control-input pl-9" placeholder="Search dependencies" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <select aria-label="Runtime category" className="control-input" value={category} onChange={event => setCategory(event.target.value)}><option value="all">All categories</option><option value="languages">Languages & build</option><option value="databases">Databases</option><option value="tools">Host tools</option></select>
        <select aria-label="Runtime status" className="control-input" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option><option value="installed">Installed</option><option value="missing">Not installed</option><option value="updates">Updates available</option></select>
      </div>}
      <div className="divide-y divide-border/50 border-y border-border/60">
        {loading && !available.length && <p role="status" className="py-8 text-sm text-muted-foreground">Inspecting host dependencies...</p>}
        {!loading && !shown.length && <p className="py-8 text-sm text-muted-foreground">{available.length ? 'No dependencies match these filters.' : 'No dependencies available.'}</p>}
        {shown.map((runtime) => <div key={runtime.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{runtime.installed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}{runtime.name}{runtime.updateAvailable && <Badge variant="outline" className="border-amber-500/30 text-amber-400">{runtime.latestVersion} available{runtime.updateRisk ? ` · ${runtime.updateRisk}` : ''}</Badge>}{runtime.id === 'mysql' && runtime.latestJob?.action === 'configure' && runtime.latestJob.status === 'success' && <Badge variant="secondary">Provisioning ready</Badge>}{runtime.installedVersions.length > 0 && <Badge variant="secondary">{runtime.installedVersions.length} project version{runtime.installedVersions.length === 1 ? '' : 's'}</Badge>}</div>
            <p className="mt-1 break-words pl-6 text-xs text-muted-foreground">{runtime.version || runtime.purpose}</p>
            {runtime.latestJob?.status === 'failed' && !runtime.activeJob && <button className="mt-1 pl-6 text-left text-[11px] text-destructive hover:underline" onClick={() => watchJob(runtime.latestJob!)}>Last operation failed: {runtime.latestJob.error}</button>}
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-1">
            {runtime.activeJob && <Button variant="outline" size="sm" className="h-8" onClick={() => watchJob(runtime.activeJob!)}><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Progress</Button>}
            {!runtime.activeJob && runtime.versioned && <Button variant="ghost" size="sm" className="h-8" onClick={() => void openVersions(runtime)}><Layers3 className="mr-2 h-3.5 w-3.5" />Versions</Button>}
            {!runtime.activeJob && runtime.installed && runtime.canConfigure && isAdmin && <Button variant="ghost" size="sm" className="h-8" title="Verify the local MySQL service and Manager provisioning credential" onClick={() => void startJob(runtime, 'configure')} disabled={anyActive}><Wrench className="mr-2 h-3.5 w-3.5" />Verify setup</Button>}
            {!runtime.activeJob && runtime.updateAvailable && runtime.canUpdate && isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => { const compatibility = runtime.updateRisk === 'major' ? ' This is a major update and may require application compatibility changes.' : ''; if (window.confirm(`Update ${runtime.name} to ${runtime.latestVersion}? Stateful services may briefly restart.${compatibility}`)) void startJob(runtime, 'update') }} disabled={anyActive}><ArrowUp className="mr-2 h-3.5 w-3.5" />Update</Button>}
            {!runtime.activeJob && !runtime.installed && runtime.canInstall && isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => void startJob(runtime, 'install')} disabled={anyActive}><Download className="mr-2 h-3.5 w-3.5" />Install</Button>}
            {!runtime.activeJob && runtime.latestJob && <Button variant="ghost" size="icon" className="h-8 w-8" title="Latest operation log" onClick={() => watchJob(runtime.latestJob!)}><Eye className="h-3.5 w-3.5" /></Button>}
          </div>
        </div>)}
      </div>
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}

      <Sheet open={job !== null} onOpenChange={(open) => { if (!open) { streamRef.current?.close(); streamRef.current = null; setJob(null) } }}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>{jobTitle}</SheetTitle><SheetDescription>{job?.requested_version ? `Version ${job.requested_version}` : job?.runtime_id === 'mysql' && job.action === 'configure' ? 'Service and provisioning credential verification' : 'Live installer output'} · {jobStatus}</SheetDescription></SheetHeader>{job && <pre ref={logRef} className="mt-6 h-[34rem] overflow-auto whitespace-pre-wrap bg-[#080a0d] p-4 font-mono text-xs leading-5">{job.log || 'Waiting for installer output...'}</pre>}</SheetContent>
      </Sheet>

      <Sheet open={versionRuntime !== null} onOpenChange={(open) => { if (!open) setVersionRuntime(null) }}>
        <SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>{versionRuntime?.name} project versions</SheetTitle><SheetDescription>Installed side by side without changing the host default.</SheetDescription></SheetHeader><div className="mt-6 divide-y divide-border border-y border-border">{versionsLoading && <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div>}{versions.map((option) => { const installed=versionRuntime?.installedVersions.includes(option.version); return <div key={option.version} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{option.label}</p>{option.date && <p className="text-xs text-muted-foreground">Released {option.date}</p>}</div>{installed ? <Badge variant="secondary">Installed</Badge> : isAdmin && <Button variant="outline" size="sm" onClick={() => versionRuntime && void startJob(versionRuntime,'install-version',option.version)} disabled={anyActive}><Download className="mr-2 h-3.5 w-3.5" />Install</Button>}</div>})}</div></SheetContent>
      </Sheet>
    </div>
  )
}
