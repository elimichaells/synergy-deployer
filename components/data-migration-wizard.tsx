'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  AlertTriangle,
  Database,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Square,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { DataRemovalAction } from '@/components/data-removal-action'

const RELATIONAL_PROVIDERS = ['postgresql', 'mysql', 'mariadb', 'sqlserver']
const ACTIVE_STATUSES = ['queued', 'running', 'validating']
const TRANSIENT_TABLES = new Set([
  'cache',
  'cache_locks',
  'failed_jobs',
  'job_batches',
  'jobs',
  'password_reset_tokens',
  'scheduled_task_runs',
  'sessions',
])

const inputClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring'
const providerLabels: Record<string, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlserver: 'SQL Server' }

interface MigrationService {
  id: string
  name: string
  provider: string
  connection_name: string
  database_name: string
  application_primary: boolean
}

interface MigrationTable {
  sourceSchema: string
  sourceTable: string
  sourceObject: string
  targetSchema: string
  targetTable: string
  targetObject: string
  targetExists: boolean
}

interface MigrationPreview {
  source: { id: string; name: string; provider: string; database: string }
  target: { id: string; name: string; provider: string; database: string }
  tables: MigrationTable[]
  existingTargetTables: number
}

interface MigrationValidation {
  table: string
  target: string
  sourceRows: string
  targetRows: string
  match: boolean
}

interface MigrationJob {
  id: string
  source_service_id: string
  source_service_name: string
  source_provider: string
  source_database: string
  target_service_id: string
  target_service_name: string
  target_provider: string
  target_database: string
  status: 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'activated'
  table_map: MigrationTable[]
  validation: MigrationValidation[] | null
  log: string
  error: string | null
  created_at: string
  finished_at: string | null
  removal_blocked_reason: string | null
}

interface DataMigrationWizardProps {
  projectId: string
  projectName: string
  services: MigrationService[]
  onAddService: () => void
  onActivated: () => Promise<boolean>
  onChanged: () => Promise<void>
  canRemove?: boolean
}

const steps = ['Route', 'Tables', 'Safety', 'Run']

function isTransient(table: MigrationTable) {
  return TRANSIENT_TABLES.has(table.sourceTable.toLowerCase())
}

function statusClass(status: MigrationJob['status']) {
  if (status === 'succeeded' || status === 'activated') return 'bg-emerald-500/15 text-emerald-300'
  if (status === 'failed' || status === 'interrupted') return 'bg-red-500/15 text-red-300'
  if (status === 'cancelled') return 'bg-amber-500/15 text-amber-300'
  return ''
}

export function DataMigrationWizard({ projectId, projectName, services, onAddService, onActivated, onChanged, canRemove = false }: DataMigrationWizardProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [sourceServiceId, setSourceServiceId] = useState('')
  const [targetServiceId, setTargetServiceId] = useState('')
  const [preview, setPreview] = useState<MigrationPreview | null>(null)
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [preserveSchema, setPreserveSchema] = useState(true)
  const [replaceTarget, setReplaceTarget] = useState(false)
  const [backupConfirmed, setBackupConfirmed] = useState(false)
  const [writesPaused, setWritesPaused] = useState(false)
  const [replacementConfirmed, setReplacementConfirmed] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [jobs, setJobs] = useState<MigrationJob[]>([])
  const [activeJob, setActiveJob] = useState<MigrationJob | null>(null)
  const [cutoverComplete, setCutoverComplete] = useState(false)
  const activeJobId = activeJob?.id

  const relationalServices = useMemo(() => services.filter((service) => RELATIONAL_PROVIDERS.includes(service.provider)), [services])
  const sourceService = relationalServices.find((service) => service.id === sourceServiceId)
  const targetService = relationalServices.find((service) => service.id === targetServiceId)
  const targetOptions = relationalServices.filter((service) => service.id !== sourceServiceId)
  const filteredTables = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!preview || !needle) return preview?.tables || []
    return preview.tables.filter((table) => table.sourceObject.toLowerCase().includes(needle) || table.targetObject.toLowerCase().includes(needle))
  }, [preview, search])
  const selectedExistingTables = useMemo(() => preview?.tables.filter((table) => selectedTables.has(table.sourceObject) && table.targetExists).length || 0, [preview, selectedTables])

  const reset = useCallback(() => {
    setStep(0)
    setSourceServiceId('')
    setTargetServiceId('')
    setPreview(null)
    setSelectedTables(new Set())
    setSearch('')
    setPreserveSchema(true)
    setReplaceTarget(false)
    setBackupConfirmed(false)
    setWritesPaused(false)
    setReplacementConfirmed(false)
    setBusy(null)
    setNotice(null)
    setActiveJob(null)
    setCutoverComplete(false)
  }, [])

  const loadJobs = useCallback(async () => {
    const response = await fetch(`/api/data/migrations?project=${encodeURIComponent(projectId)}`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Migration history could not be loaded')
    setJobs(body.migrations || [])
    return body.migrations as MigrationJob[]
  }, [projectId])

  useEffect(() => {
    if (!open) return
    void loadJobs().catch((error) => setNotice(error instanceof Error ? error.message : 'Migration history could not be loaded'))
  }, [loadJobs, open])

  const refreshActiveJob = useCallback(async () => {
    if (!activeJobId) return
    const response = await fetch(`/api/data/migrations/${activeJobId}`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Migration progress could not be loaded')
    setActiveJob(body.migration)
    setJobs((current) => [body.migration, ...current.filter((item) => item.id !== body.migration.id)])
  }, [activeJobId])

  useEffect(() => {
    if (!open || !activeJob || !ACTIVE_STATUSES.includes(activeJob.status)) return
    const timer = window.setInterval(() => void refreshActiveJob().catch((error) => setNotice(error instanceof Error ? error.message : 'Migration progress could not be loaded')), 2000)
    return () => window.clearInterval(timer)
  }, [activeJob, open, refreshActiveJob])

  const inspectDatabases = async () => {
    if (!sourceServiceId || !targetServiceId) return
    setBusy('preview')
    setNotice(null)
    try {
      const response = await fetch('/api/data/migrations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceServiceId, targetServiceId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Database inspection failed')
      const nextPreview = body.preview as MigrationPreview
      setPreview(nextPreview)
      setSelectedTables(new Set(nextPreview.tables.filter((table) => !isTransient(table)).map((table) => table.sourceObject)))
      setReplaceTarget(false)
      setReplacementConfirmed(false)
      setStep(1)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Database inspection failed')
    } finally {
      setBusy(null)
    }
  }

  const toggleTable = (name: string) => {
    setSelectedTables((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const startMigration = async () => {
    if (!preview || !selectedTables.size) return
    setBusy('start')
    setNotice(null)
    try {
      const response = await fetch('/api/data/migrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceServiceId,
          targetServiceId,
          preserveSchema,
          replaceTarget,
          backupConfirmed,
          writesPaused,
          tables: [...selectedTables],
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Migration could not be started')
      setActiveJob(body.migration)
      setJobs((current) => [body.migration, ...current.filter((item) => item.id !== body.migration.id)])
      setStep(3)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Migration could not be started')
    } finally {
      setBusy(null)
    }
  }

  const cancelMigration = async () => {
    if (!activeJob || !window.confirm('Cancel this migration? The source database will remain unchanged.')) return
    setBusy('cancel')
    try {
      const response = await fetch(`/api/data/migrations/${activeJob.id}/cancel`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Migration could not be cancelled')
      await refreshActiveJob()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Migration could not be cancelled')
    } finally {
      setBusy(null)
    }
  }

  const activateTarget = async () => {
    if (!activeJob) return
    setBusy('activate')
    setNotice(null)
    try {
      const response = await fetch(`/api/data/migrations/${activeJob.id}/activate`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Migration target could not be activated')
      setCutoverComplete(true)
      await refreshActiveJob()
      await onChanged()
      try {
        const synced = await onActivated()
        setNotice(synced
          ? 'Cutover complete. The target is now the application database and the application was restarted with its updated environment.'
          : 'The target is now the application database. Environment synchronization was cancelled and can be completed from Project Data Services.')
      } catch (error) {
        setNotice(`The target is now the application database, but environment synchronization needs attention: ${error instanceof Error ? error.message : 'sync failed'}`)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Migration target could not be activated')
    } finally {
      setBusy(null)
    }
  }

  const openJob = (job: MigrationJob) => {
    setActiveJob(job)
    setCutoverComplete(job.status === 'activated')
    setStep(3)
    setNotice(null)
  }

  const canStart = backupConfirmed && writesPaused && selectedTables.size > 0 && (selectedExistingTables === 0 || (replaceTarget && replacementConfirmed))

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { reset(); setOpen(true) }}>
        <ArrowRightLeft className="mr-2 h-4 w-4" />Migrate data
      </Button>
      <Sheet open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) void onChanged() }}>
        <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-3xl">
          <SheetHeader className="border-b border-border px-6 py-5 pr-12">
            <SheetTitle>Database migration</SheetTitle>
            <SheetDescription>{projectName} · guided relational database transfer</SheetDescription>
          </SheetHeader>

          <div className="border-b border-border px-6 py-4">
            <div className="grid grid-cols-4 gap-2" aria-label="Migration progress">
              {steps.map((label, index) => (
                <div key={label} className="min-w-0">
                  <div className={`mb-2 h-1 rounded-sm ${index <= step ? 'bg-primary' : 'bg-muted'}`} />
                  <div className={`flex items-center gap-2 text-xs ${index === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${index < step ? 'border-primary bg-primary text-primary-foreground' : index === step ? 'border-primary text-primary' : 'border-border'}`}>
                      {index < step ? <Check className="h-3 w-3" /> : index + 1}
                    </span>
                    <span className="truncate">{label}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {notice && <div className="mb-4 flex items-start gap-2 border-y border-border bg-muted/30 px-3 py-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /><p>{notice}</p></div>}

            {step === 0 && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold">Choose the migration route</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Both databases must be attached to this application before Manager can inspect them.</p>
                </div>
                {relationalServices.length < 2 ? (
                  <div className="border-y border-border py-8 text-center">
                    <Database className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium">Two relational data services are required</p>
                    <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">Attach the existing source or provision a target, then return to this wizard.</p>
                    <Button className="mt-4" size="sm" onClick={() => { setOpen(false); onAddService() }}>Add data service</Button>
                  </div>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
                      <label className="grid gap-2 text-sm">Source database
                        <select className={inputClass} value={sourceServiceId} onChange={(event) => { setSourceServiceId(event.target.value); setTargetServiceId(''); setPreview(null) }}>
                          <option value="">Select source</option>
                          {relationalServices.map((service) => <option key={service.id} value={service.id}>{service.name} · {providerLabels[service.provider]} · {service.database_name}</option>)}
                        </select>
                      </label>
                      <ArrowRight className="mb-3 hidden h-4 w-4 text-muted-foreground sm:block" />
                      <label className="grid gap-2 text-sm">Target database
                        <select className={inputClass} value={targetServiceId} onChange={(event) => { setTargetServiceId(event.target.value); setPreview(null) }} disabled={!sourceServiceId}>
                          <option value="">Select target</option>
                          {targetOptions.map((service) => <option key={service.id} value={service.id}>{service.name} · {providerLabels[service.provider]} · {service.database_name}</option>)}
                        </select>
                      </label>
                    </div>
                    {(sourceService || targetService) && <div className="divide-y divide-border border-y border-border text-sm">
                      {sourceService && <div className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 py-3"><span className="text-muted-foreground">Source</span><span className="min-w-0 truncate font-mono text-xs">{sourceService.database_name}</span>{sourceService.application_primary && <Badge variant="secondary">Application DB</Badge>}</div>}
                      {targetService && <div className="grid grid-cols-[5rem_1fr_auto] items-center gap-3 py-3"><span className="text-muted-foreground">Target</span><span className="min-w-0 truncate font-mono text-xs">{targetService.database_name}</span>{targetService.application_primary && <Badge variant="secondary">Application DB</Badge>}</div>}
                    </div>}
                  </>
                )}

                {jobs.length > 0 && <div>
                  <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">Recent migrations</h3><Button variant="ghost" size="icon" title="Refresh migration history" onClick={() => void loadJobs()}><RefreshCw className="h-4 w-4" /></Button></div>
                  <div className="divide-y divide-border border-y border-border">
                    {jobs.slice(0, 4).map((job) => <div key={job.id} className="flex items-center gap-2"><button type="button" className="grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-3 py-3 text-left hover:bg-muted/30" onClick={() => openJob(job)}><span className="min-w-0"><span className="block truncate text-sm">{job.source_database} <ArrowRight className="mx-1 inline h-3 w-3" /> {job.target_database}</span><span className="mt-1 block text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString()}</span></span><Badge variant="secondary" className={statusClass(job.status)}>{ACTIVE_STATUSES.includes(job.status) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{job.status}</Badge></button>{canRemove && <DataRemovalAction kind="migration" name={`${job.source_database} to ${job.target_database}`} endpoint={`/api/data/migrations/${job.id}`} blockedReason={job.removal_blocked_reason} disabled={!!busy} onRemoved={async () => { await loadJobs(); await onChanged() }} />}</div>)}
                  </div>
                </div>}
              </div>
            )}

            {step === 1 && preview && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Select data to transfer</h3><p className="mt-1 text-sm text-muted-foreground">Runtime tables are excluded by default so caches, sessions, and queued work start clean.</p></div><Badge variant="secondary">{selectedTables.size} of {preview.tables.length}</Badge></div>
                <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setSelectedTables(new Set(preview.tables.map((table) => table.sourceObject)))}>Select all</Button><Button variant="outline" size="sm" onClick={() => setSelectedTables(new Set(preview.tables.filter((table) => !isTransient(table)).map((table) => table.sourceObject)))}>Persistent only</Button><Button variant="ghost" size="sm" onClick={() => setSelectedTables(new Set())}>Clear</Button></div>
                <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><input className={`${inputClass} pl-9`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter tables" /></div>
                <div className="max-h-72 overflow-y-auto border-y border-border">
                  {filteredTables.map((table) => <label key={table.sourceObject} className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/60 px-2 py-3 text-xs last:border-0 hover:bg-muted/30"><input type="checkbox" className="h-4 w-4 accent-primary" checked={selectedTables.has(table.sourceObject)} onChange={() => toggleTable(table.sourceObject)} /><span className="min-w-0"><span className="block truncate font-mono">{table.sourceObject}</span><span className="mt-1 block truncate text-muted-foreground">to {table.targetObject}</span></span><span className="flex gap-1">{isTransient(table) && <Badge variant="outline">Runtime</Badge>}{table.targetExists && <Badge variant="secondary">Exists</Badge>}</span></label>)}
                </div>
                <label className="flex items-center justify-between gap-4 border-y border-border py-3 text-sm"><span><span className="block font-medium">Migrate compatible keys and constraints</span><span className="mt-1 block text-xs text-muted-foreground">Sling translates supported provider schema alongside the selected data.</span></span><Switch checked={preserveSchema} onCheckedChange={setPreserveSchema} /></label>
                {selectedExistingTables > 0 && <label className="flex items-center justify-between gap-4 border-y border-border py-3 text-sm"><span><span className="block font-medium">Recreate selected target tables</span><span className="mt-1 block text-xs text-muted-foreground">Required because {selectedExistingTables} selected target table{selectedExistingTables === 1 ? '' : 's'} already exist.</span></span><Switch checked={replaceTarget} onCheckedChange={(checked) => { setReplaceTarget(checked); if (!checked) setReplacementConfirmed(false) }} /></label>}
              </div>
            )}

            {step === 2 && preview && (
              <div className="space-y-5">
                <div><h3 className="text-sm font-semibold">Confirm operational safety</h3><p className="mt-1 text-sm text-muted-foreground">The source remains unchanged. Selected target tables are loaded using a full refresh.</p></div>
                <div className="divide-y divide-border border-y border-border text-sm">
                  <div className="grid grid-cols-[7rem_1fr] gap-3 py-3"><span className="text-muted-foreground">Route</span><span>{providerLabels[preview.source.provider]} to {providerLabels[preview.target.provider]}</span></div>
                  <div className="grid grid-cols-[7rem_1fr] gap-3 py-3"><span className="text-muted-foreground">Databases</span><span className="break-all font-mono text-xs">{preview.source.database} to {preview.target.database}</span></div>
                  <div className="grid grid-cols-[7rem_1fr] gap-3 py-3"><span className="text-muted-foreground">Tables</span><span>{selectedTables.size} selected · {selectedExistingTables} existing on target</span></div>
                </div>
                {targetService?.application_primary && <div className="flex gap-3 border-y border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /><p>The target is the active application database. Keep the application and workers paused until validation finishes.</p></div>}
                <div className="space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} /><span><span className="block font-medium">Backups are complete</span><span className="mt-1 block text-xs text-muted-foreground">I have a restorable backup of the source and any existing target data.</span></span></label>
                  <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={writesPaused} onChange={(event) => setWritesPaused(event.target.checked)} /><span><span className="block font-medium">Application writes are paused</span><span className="mt-1 block text-xs text-muted-foreground">Web traffic, scheduled tasks, and workers cannot change either database during the transfer.</span></span></label>
                  {selectedExistingTables > 0 && <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={replacementConfirmed} onChange={(event) => setReplacementConfirmed(event.target.checked)} /><span><span className="block font-medium">Target replacement is understood</span><span className="mt-1 block text-xs text-muted-foreground">The selected existing target tables can be dropped and recreated.</span></span></label>}
                </div>
              </div>
            )}

            {step === 3 && activeJob && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">Migration run</h3><p className="mt-1 font-mono text-xs text-muted-foreground">{activeJob.source_database} to {activeJob.target_database}</p></div><Badge variant="secondary" className={statusClass(activeJob.status)}>{ACTIVE_STATUSES.includes(activeJob.status) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{activeJob.status}</Badge></div>
                {activeJob.error && <div className="flex gap-2 border-y border-red-500/30 bg-red-500/5 px-3 py-3 text-sm text-red-300"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>{activeJob.error}</p></div>}
                <div><p className="mb-2 text-sm font-medium">Live output</p><pre className="h-56 overflow-auto border border-border bg-black/30 p-3 font-mono text-xs leading-5 whitespace-pre-wrap">{activeJob.log || 'Waiting for migration output...'}</pre></div>
                {activeJob.validation && <div><p className="mb-2 text-sm font-medium">Row-count validation</p><div className="max-h-56 overflow-y-auto border-y border-border">{activeJob.validation.map((item) => <div key={item.table} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-border/60 px-2 py-2 text-xs last:border-0">{item.match ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-red-400" />}<span className="truncate font-mono">{item.table}</span><span>{item.sourceRows} / {item.targetRows}</span></div>)}</div></div>}
                {activeJob.status === 'succeeded' && !cutoverComplete && <div className="border-y border-border py-4"><p className="text-sm font-medium">Validation passed</p><p className="mt-1 text-xs text-muted-foreground">Activate the target to select it as the application database, review the `.env` change, and restart only {projectName}.</p><Button className="mt-3" onClick={() => void activateTarget()} disabled={busy === 'activate'}>{busy === 'activate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Activate target and review cutover</Button></div>}
                {(activeJob.status === 'activated' || cutoverComplete) && <div className="flex gap-3 border-y border-emerald-500/30 bg-emerald-500/5 px-3 py-3 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /><p>The migration target is selected as the application database.</p></div>}
              </div>
            )}
          </div>

          <div className="flex min-h-16 items-center justify-between gap-3 border-t border-border px-6 py-3">
            <div>{step > 0 && step < 3 && <Button variant="ghost" onClick={() => setStep((current) => current - 1)} disabled={!!busy}>Back</Button>}</div>
            <div className="flex gap-2">
              {step === 0 && relationalServices.length >= 2 && <Button onClick={() => void inspectDatabases()} disabled={!sourceServiceId || !targetServiceId || busy === 'preview'}>{busy === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}Inspect databases</Button>}
              {step === 1 && <Button onClick={() => setStep(2)} disabled={!selectedTables.size || (selectedExistingTables > 0 && !replaceTarget)}>Review safety<ArrowRight className="ml-2 h-4 w-4" /></Button>}
              {step === 2 && <Button onClick={() => void startMigration()} disabled={!canStart || busy === 'start'}>{busy === 'start' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Start migration</Button>}
              {step === 3 && activeJob && ACTIVE_STATUSES.includes(activeJob.status) && <Button variant="outline" onClick={() => void cancelMigration()} disabled={busy === 'cancel'}>{busy === 'cancel' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}Cancel</Button>}
              {step === 3 && activeJob && !ACTIVE_STATUSES.includes(activeJob.status) && <Button variant="outline" onClick={() => { reset(); void loadJobs() }}>New migration</Button>}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
