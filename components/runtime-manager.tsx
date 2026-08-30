'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUp, CheckCircle2, Download, Eye, Layers3, Loader2, RefreshCw, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

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

export function RuntimeManager({ isAdmin }: { isAdmin: boolean }) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [job, setJob] = useState<RuntimeJob | null>(null)
  const [versionRuntime, setVersionRuntime] = useState<RuntimeStatus | null>(null)
  const [versions, setVersions] = useState<VersionOption[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
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
        setMessage(payload.job.status === 'success' ? 'Host dependency operation completed successfully.' : payload.job.error || 'Host dependency operation failed.')
        void load()
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
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium">Host dependencies</p><p className="text-[11px] text-muted-foreground">Live installation logs, safe update checks, and side-by-side project toolchains.</p></div>
        <div className="flex gap-1">
          {isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => void checkUpdates()} disabled={checking || anyActive}>{checking ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}Check updates</Button>}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void load()} disabled={loading} title="Refresh runtimes"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>
      <div className="divide-y divide-border/50 border-y border-border/60">
        {runtimes.map((runtime) => <div key={runtime.id} className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{runtime.installed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}{runtime.name}{runtime.updateAvailable && <Badge variant="outline" className="border-amber-500/30 text-amber-400">{runtime.latestVersion} available{runtime.updateRisk ? ` · ${runtime.updateRisk}` : ''}</Badge>}{runtime.installedVersions.length > 0 && <Badge variant="secondary">{runtime.installedVersions.length} project version{runtime.installedVersions.length === 1 ? '' : 's'}</Badge>}</div>
            <p className="mt-0.5 truncate pl-6 text-[11px] text-muted-foreground">{runtime.version || runtime.purpose}</p>
            {runtime.latestJob?.status === 'failed' && !runtime.activeJob && <button className="mt-1 pl-6 text-left text-[11px] text-destructive hover:underline" onClick={() => watchJob(runtime.latestJob!)}>Last operation failed: {runtime.latestJob.error}</button>}
          </div>
          <div className="flex shrink-0 gap-1">
            {runtime.activeJob && <Button variant="outline" size="sm" className="h-8" onClick={() => watchJob(runtime.activeJob!)}><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Progress</Button>}
            {!runtime.activeJob && runtime.versioned && <Button variant="ghost" size="sm" className="h-8" onClick={() => void openVersions(runtime)}><Layers3 className="mr-2 h-3.5 w-3.5" />Versions</Button>}
            {!runtime.activeJob && runtime.installed && runtime.canConfigure && isAdmin && <Button variant="ghost" size="sm" className="h-8" onClick={() => void startJob(runtime, 'configure')} disabled={anyActive}><Wrench className="mr-2 h-3.5 w-3.5" />Configure</Button>}
            {!runtime.activeJob && runtime.updateAvailable && runtime.canUpdate && isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => { const compatibility = runtime.updateRisk === 'major' ? ' This is a major update and may require application compatibility changes.' : ''; if (window.confirm(`Update ${runtime.name} to ${runtime.latestVersion}? Stateful services may briefly restart.${compatibility}`)) void startJob(runtime, 'update') }} disabled={anyActive}><ArrowUp className="mr-2 h-3.5 w-3.5" />Update</Button>}
            {!runtime.activeJob && !runtime.installed && runtime.canInstall && isAdmin && <Button variant="outline" size="sm" className="h-8" onClick={() => void startJob(runtime, 'install')} disabled={anyActive}><Download className="mr-2 h-3.5 w-3.5" />Install</Button>}
            {!runtime.activeJob && runtime.latestJob && <Button variant="ghost" size="icon" className="h-8 w-8" title="Latest operation log" onClick={() => watchJob(runtime.latestJob!)}><Eye className="h-3.5 w-3.5" /></Button>}
          </div>
        </div>)}
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      <Sheet open={job !== null} onOpenChange={(open) => { if (!open) setJob(null) }}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>{job ? `${job.runtime_id} ${job.action}` : 'Host dependency operation'}</SheetTitle><SheetDescription>{job?.requested_version ? `Version ${job.requested_version}` : 'Live installer output'} · {job?.status}</SheetDescription></SheetHeader>{job && <pre ref={logRef} className="mt-6 h-[34rem] overflow-auto whitespace-pre-wrap bg-[#080a0d] p-4 font-mono text-xs leading-5">{job.log || 'Waiting for installer output...'}</pre>}</SheetContent>
      </Sheet>

      <Sheet open={versionRuntime !== null} onOpenChange={(open) => { if (!open) setVersionRuntime(null) }}>
        <SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>{versionRuntime?.name} project versions</SheetTitle><SheetDescription>Installed side by side without changing the host default.</SheetDescription></SheetHeader><div className="mt-6 divide-y divide-border border-y border-border">{versionsLoading && <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div>}{versions.map((option) => { const installed=versionRuntime?.installedVersions.includes(option.version); return <div key={option.version} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{option.label}</p>{option.date && <p className="text-xs text-muted-foreground">Released {option.date}</p>}</div>{installed ? <Badge variant="secondary">Installed</Badge> : isAdmin && <Button variant="outline" size="sm" onClick={() => versionRuntime && void startJob(versionRuntime,'install-version',option.version)} disabled={anyActive}><Download className="mr-2 h-3.5 w-3.5" />Install</Button>}</div>})}</div></SheetContent>
      </Sheet>
    </div>
  )
}
