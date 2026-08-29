'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, CalendarClock, Clock3, FileText, Loader2, Pause, Pencil, Play, Plus,
  RefreshCw, RotateCcw, ServerCog, Square, Trash2,
} from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface SessionUser { id: string; name: string; email: string; role: 'admin' | 'operator' | 'viewer' }
type CronLanguage = 'laravel' | 'php' | 'node' | 'python' | 'go' | 'custom'
interface CronJob {
  id: string; project_id: string | null; project_name: string | null; project_type: string | null
  language: CronLanguage; name: string; description: string | null; schedule: string; timezone: string; command: string
  working_directory: string; timeout_seconds: number; enabled: boolean; next_run_at: string | null
  last_started_at: string | null; last_finished_at: string | null
  last_status: 'idle' | 'running' | 'success' | 'failed' | 'interrupted'; last_exit_code: number | null; last_output: string | null
}
interface ProjectOption { id: string; name: string; environment: 'production' | 'staging'; project_type: string; root_path: string }
interface Worker {
  id: string; name: string; description: string | null; command: string; working_directory: string; pm2_name: string
  enabled: boolean; status: string; pid: number | null; uptime: number | null; restarts: number; cpu: number; memory: number
}

const languageOptions: Array<{ value: CronLanguage; label: string }> = [
  { value: 'laravel', label: 'Laravel (PHP)' },
  { value: 'php', label: 'PHP' },
  { value: 'node', label: 'Node.js' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'custom', label: 'Custom command' },
]
const schedulePresets = [
  { value: '* * * * *', label: 'Every minute' },
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 2 * * *', label: 'Daily at 02:00' },
  { value: '0 8 * * 1-5', label: 'Weekdays at 08:00' },
]

function defaultCronCommand(language: CronLanguage) {
  if (language === 'laravel') return 'php artisan schedule:run'
  if (language === 'php') return 'php cron.php'
  if (language === 'node') return 'npm run cron'
  if (language === 'python') return 'python cron.py'
  if (language === 'go') return '.\\app.exe cron'
  return ''
}

function inferCronLanguage(projectType: string): CronLanguage {
  if (projectType === 'laravel') return 'laravel'
  if (projectType === 'node' || projectType === 'next' || projectType === 'angular') return 'node'
  if (projectType === 'go') return 'go'
  return 'custom'
}

const emptyCron = { projectId: '', language: 'laravel' as CronLanguage, name: '', description: '', schedule: '* * * * *', timezone: 'UTC', command: 'php artisan schedule:run', workingDirectory: '', timeoutSeconds: 300, enabled: true }
const emptyWorker = { name: '', description: '', command: '', workingDirectory: 'C:\\web', pm2Name: '', enabled: true }
const timezones = ['UTC', 'Africa/Accra', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai']

function relativeTime(value: string | null) {
  if (!value) return 'Not scheduled'
  const delta = new Date(value).getTime() - Date.now()
  const abs = Math.abs(delta)
  if (abs < 60_000) return delta >= 0 ? 'in under a minute' : 'under a minute ago'
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return delta >= 0 ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return delta >= 0 ? `in ${hours}h` : `${hours}h ago`
  const days = Math.round(hours / 24)
  return delta >= 0 ? `in ${days}d` : `${days}d ago`
}

function workerUptime(started: number | null) {
  if (!started) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export default function AutomationPage() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [cronJobs, setCronJobs] = useState<CronJob[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [activeTab, setActiveTab] = useState<'cron' | 'workers'>('cron')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [cronEditor, setCronEditor] = useState<CronJob | 'new' | null>(null)
  const [workerEditor, setWorkerEditor] = useState<Worker | 'new' | null>(null)
  const [cronForm, setCronForm] = useState(emptyCron)
  const [workerForm, setWorkerForm] = useState(emptyWorker)
  const [workerLog, setWorkerLog] = useState<{ name: string; output: string } | null>(null)

  const canWrite = user?.role === 'admin' || user?.role === 'operator'
  const canDelete = user?.role === 'admin'

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [meRes, cronRes, workerRes, projectsRes] = await Promise.all([
        fetch('/api/auth/me'), fetch('/api/automation/cron'), fetch('/api/automation/workers'), fetch('/api/sites'),
      ])
      if (!cronRes.ok || !workerRes.ok || !projectsRes.ok) throw new Error('Failed to load automation data')
      const me = meRes.ok ? await meRes.json() : { user: null }
      setUser(me.user)
      setCronJobs(await cronRes.json())
      setWorkers(await workerRes.json())
      setProjects(await projectsRes.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automation data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const openCron = (job: CronJob | 'new') => {
    setCronEditor(job)
    setCronForm(job === 'new' ? emptyCron : {
      projectId: job.project_id || '', language: job.language || 'custom', name: job.name, description: job.description || '', schedule: job.schedule, timezone: job.timezone,
      command: job.command, workingDirectory: job.working_directory, timeoutSeconds: job.timeout_seconds, enabled: job.enabled,
    })
  }

  const selectCronProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) {
      setCronForm((current) => ({ ...current, projectId: '', workingDirectory: '' }))
      return
    }
    const language = inferCronLanguage(project.project_type)
    setCronForm((current) => ({
      ...current,
      projectId,
      language,
      workingDirectory: project.root_path,
      command: defaultCronCommand(language),
      schedule: language === 'laravel' ? '* * * * *' : current.schedule,
    }))
  }

  const selectCronLanguage = (language: CronLanguage) => {
    setCronForm((current) => ({
      ...current,
      language,
      command: defaultCronCommand(language),
      schedule: language === 'laravel' ? '* * * * *' : current.schedule,
    }))
  }

  const openWorker = (worker: Worker | 'new') => {
    setWorkerEditor(worker)
    setWorkerForm(worker === 'new' ? emptyWorker : {
      name: worker.name, description: worker.description || '', command: worker.command,
      workingDirectory: worker.working_directory, pm2Name: worker.pm2_name, enabled: worker.enabled,
    })
  }

  const saveCron = async () => {
    if (!cronEditor || !canWrite) return
    setBusy('save-cron'); setError(null)
    try {
      const res = await fetch(cronEditor === 'new' ? '/api/automation/cron' : `/api/automation/cron/${cronEditor.id}`, {
        method: cronEditor === 'new' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cronForm),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save cron job')
      setCronEditor(null); await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save cron job') }
    finally { setBusy(null) }
  }

  const saveWorker = async () => {
    if (!workerEditor || !canWrite) return
    setBusy('save-worker'); setError(null)
    try {
      const res = await fetch(workerEditor === 'new' ? '/api/automation/workers' : `/api/automation/workers/${workerEditor.id}`, {
        method: workerEditor === 'new' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workerForm),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save worker')
      setWorkerEditor(null); await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save worker') }
    finally { setBusy(null) }
  }

  const cronAction = async (job: CronJob, action: 'run' | 'toggle' | 'delete') => {
    if (!canWrite) return
    if (action === 'delete' && !window.confirm(`Delete cron job “${job.name}”?`)) return
    setBusy(`${job.id}-${action}`); setError(null)
    try {
      const url = action === 'run' ? `/api/automation/cron/${job.id}/run` : `/api/automation/cron/${job.id}`
      const res = await fetch(url, action === 'run' ? { method: 'POST' } : action === 'delete'
        ? { method: 'DELETE' }
        : { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !job.enabled }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to ${action} cron job`)
      await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : 'Cron action failed') }
    finally { setBusy(null) }
  }

  const workerAction = async (worker: Worker, action: 'start' | 'stop' | 'restart' | 'delete' | 'logs') => {
    if (!canWrite && action !== 'logs') return
    if (action === 'delete' && !window.confirm(`Delete worker “${worker.name}” and its PM2 process?`)) return
    setBusy(`${worker.id}-${action}`); setError(null)
    try {
      if (action === 'logs') {
        const res = await fetch(`/api/automation/workers/${worker.id}/logs`)
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to load worker logs')
        setWorkerLog({ name: worker.name, output: data.output || 'No log output.' })
      } else {
        const res = await fetch(action === 'delete' ? `/api/automation/workers/${worker.id}` : `/api/automation/workers/${worker.id}/${action}`, { method: action === 'delete' ? 'DELETE' : 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Failed to ${action} worker`)
        await refresh()
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Worker action failed') }
    finally { setBusy(null) }
  }

  const runningWorkers = useMemo(() => workers.filter((worker) => worker.status === 'online').length, [workers])
  const enabledCron = useMemo(() => cronJobs.filter((job) => job.enabled).length, [cronJobs])

  return (
    <AppShell title="Automation" subtitle="Scheduled jobs, background workers, and unattended operations." user={{ name: user?.name, role: user?.role }} actions={
      <Button variant="secondary" size="sm" onClick={() => void refresh()}><RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
    }>
      {error && <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="surface-card p-4"><p className="text-xs text-muted-foreground">Enabled schedules</p><p className="mt-1 text-2xl font-semibold">{enabledCron}<span className="text-sm text-muted-foreground"> / {cronJobs.length}</span></p></div>
        <div className="surface-card p-4"><p className="text-xs text-muted-foreground">Online workers</p><p className="mt-1 text-2xl font-semibold text-emerald-400">{runningWorkers}<span className="text-sm text-muted-foreground"> / {workers.length}</span></p></div>
        <div className="surface-card p-4"><p className="text-xs text-muted-foreground">Scheduler</p><p className="mt-2 flex items-center gap-2 text-sm font-medium text-emerald-400"><Activity className="h-4 w-4" />Manager scheduler active</p></div>
      </div>

      <div className="mb-5 flex items-center justify-between border-b border-border">
        <div className="flex gap-1">
          <button onClick={() => setActiveTab('cron')} className={`border-b-2 px-4 py-3 text-sm font-medium ${activeTab === 'cron' ? 'border-cyan-400 text-foreground' : 'border-transparent text-muted-foreground'}`}>Cron jobs</button>
          <button onClick={() => setActiveTab('workers')} className={`border-b-2 px-4 py-3 text-sm font-medium ${activeTab === 'workers' ? 'border-cyan-400 text-foreground' : 'border-transparent text-muted-foreground'}`}>Workers</button>
        </div>
        {canWrite && <Button size="sm" onClick={() => activeTab === 'cron' ? openCron('new') : openWorker('new')}><Plus className="mr-2 h-3.5 w-3.5" />{activeTab === 'cron' ? 'New cron job' : 'New worker'}</Button>}
      </div>

      {activeTab === 'cron' ? (
        <div className="space-y-3">
          {cronJobs.length === 0 && !loading && <Empty icon={<CalendarClock className="h-7 w-7" />} title="No cron jobs" text="Create a schedule for backups, cleanup, syncs, or maintenance commands." />}
          {cronJobs.map((job) => (
            <div key={job.id} className="rounded-md border border-border bg-card p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">{job.name}</p>
                    <StatusBadge status={job.last_status} />
                    <Badge variant="outline" className="text-[10px]">{job.project_name || 'Legacy job'}</Badge>
                    <Badge variant="outline" className="text-[10px] capitalize">{job.language === 'node' ? 'Node.js' : job.language}</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{job.description || job.command}</p>
                </div>
                <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4 lg:w-[34rem]">
                  <Metric label="Schedule" value={job.schedule} mono />
                  <Metric label="Timezone" value={job.timezone} />
                  <Metric label="Next run" value={job.enabled ? relativeTime(job.next_run_at) : 'Paused'} />
                  <Metric label="Last run" value={relativeTime(job.last_finished_at)} />
                </div>
                <div className="flex items-center gap-1">
                  {canWrite && <IconButton title="Run now" disabled={!!busy || job.last_status === 'running'} onClick={() => void cronAction(job, 'run')} icon={job.last_status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} />}
                  {canWrite && <IconButton title={job.enabled ? 'Pause schedule' : 'Enable schedule'} disabled={!!busy} onClick={() => void cronAction(job, 'toggle')} icon={job.enabled ? <Pause className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />} />}
                  {canWrite && <IconButton title="Edit cron job" onClick={() => openCron(job)} icon={<Pencil className="h-4 w-4" />} />}
                  {canDelete && <IconButton title="Delete cron job" danger onClick={() => void cronAction(job, 'delete')} icon={<Trash2 className="h-4 w-4" />} />}
                </div>
              </div>
              {job.last_output && <details className="mt-3 border-t border-border pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">Last output</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-[#090b0e] p-3 font-mono text-[11px] leading-5 text-slate-300">{job.last_output}</pre></details>}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {workers.length === 0 && !loading && <Empty icon={<ServerCog className="h-7 w-7" />} title="No workers" text="Register queues, consumers, processors, or other long-running background commands." />}
          {workers.map((worker) => (
            <div key={worker.id} className="grid gap-4 rounded-md border border-border bg-card p-4 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(5rem,0.6fr))_auto] lg:items-center">
              <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{worker.name}</p><Badge className={worker.status === 'online' ? 'bg-emerald-500/10 text-emerald-300' : worker.status === 'errored' ? 'bg-red-500/10 text-red-300' : 'bg-secondary text-muted-foreground'}>{worker.status}</Badge></div><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{worker.pm2_name} · {worker.command}</p></div>
              <Metric label="Uptime" value={workerUptime(worker.uptime)} />
              <Metric label="CPU" value={`${worker.cpu}%`} mono />
              <Metric label="Memory" value={`${worker.memory} MB`} mono />
              <Metric label="Restarts" value={String(worker.restarts)} mono />
              <div className="flex items-center gap-1">
                <IconButton title="View logs" onClick={() => void workerAction(worker, 'logs')} icon={<FileText className="h-4 w-4" />} />
                {canWrite && worker.status !== 'online' && <IconButton title="Start worker" disabled={!!busy || !worker.enabled} onClick={() => void workerAction(worker, 'start')} icon={<Play className="h-4 w-4" />} />}
                {canWrite && worker.status === 'online' && <IconButton title="Restart worker" disabled={!!busy} onClick={() => void workerAction(worker, 'restart')} icon={<RotateCcw className="h-4 w-4" />} />}
                {canWrite && worker.status === 'online' && <IconButton title="Stop worker" disabled={!!busy} onClick={() => void workerAction(worker, 'stop')} icon={<Square className="h-4 w-4" />} />}
                {canWrite && <IconButton title="Edit worker" onClick={() => openWorker(worker)} icon={<Pencil className="h-4 w-4" />} />}
                {canDelete && <IconButton title="Delete worker" danger onClick={() => void workerAction(worker, 'delete')} icon={<Trash2 className="h-4 w-4" />} />}
              </div>
            </div>
          ))}
        </div>
      )}

      <Sheet open={cronEditor !== null} onOpenChange={(open) => !open && setCronEditor(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{cronEditor === 'new' ? 'New project cron job' : 'Edit project cron job'}</SheetTitle>
            <SheetDescription>Schedule a framework command against one managed project.</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Project
                <select value={cronForm.projectId} onChange={(event) => selectCronProject(event.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring">
                  <option value="">Select a project</option>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.environment})</option>)}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Language / framework
                <select value={cronForm.language} onChange={(event) => selectCronLanguage(event.target.value as CronLanguage)} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring">
                  {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>

            <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-medium uppercase text-muted-foreground">Project directory</p>
              <code className="mt-1 block break-all text-xs">{cronForm.workingDirectory || 'Select a project'}</code>
            </div>

            <TextField label="Name" value={cronForm.name} onChange={(name) => setCronForm({ ...cronForm, name })} placeholder="Laravel scheduler" />
            <TextField label="Description" value={cronForm.description} onChange={(description) => setCronForm({ ...cronForm, description })} placeholder="Optional operator note" />

            <div className="grid gap-4 sm:grid-cols-3">
              <label className="grid gap-2 text-sm font-medium">
                Schedule preset
                <select
                  value={schedulePresets.some((preset) => preset.value === cronForm.schedule) ? cronForm.schedule : 'custom'}
                  onChange={(event) => event.target.value !== 'custom' && setCronForm({ ...cronForm, schedule: event.target.value })}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
                >
                  {schedulePresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                  <option value="custom">Custom expression</option>
                </select>
              </label>
              <TextField label="Cron expression" mono value={cronForm.schedule} onChange={(schedule) => setCronForm({ ...cronForm, schedule })} placeholder="* * * * *" />
              <SelectField label="Timezone" value={cronForm.timezone} onChange={(timezone) => setCronForm({ ...cronForm, timezone })} options={timezones} />
            </div>

            {cronForm.language === 'laravel' && (
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
                <p className="text-xs font-medium text-emerald-300">Laravel scheduler</p>
                <code className="mt-1 block break-all text-[11px] text-emerald-200/80">cd &quot;{cronForm.workingDirectory || 'project directory'}&quot; &amp;&amp; php artisan schedule:run</code>
                <p className="mt-1 text-[11px] text-muted-foreground">Manager sets the project directory automatically and captures output in the run history.</p>
              </div>
            )}

            <ScriptField label="Command" value={cronForm.command} onChange={(command) => setCronForm({ ...cronForm, command })} placeholder={defaultCronCommand(cronForm.language) || 'Enter command'} />
            <TextField label="Timeout (seconds)" type="number" value={String(cronForm.timeoutSeconds)} onChange={(value) => setCronForm({ ...cronForm, timeoutSeconds: Number(value) })} />
            <ToggleField label="Enabled" description="Calculate the next run and execute this schedule automatically." checked={cronForm.enabled} onChange={(enabled) => setCronForm({ ...cronForm, enabled })} />
            <Button className="w-full" disabled={busy === 'save-cron' || !cronForm.projectId} onClick={() => void saveCron()}>
              {busy === 'save-cron' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save cron job
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={workerEditor !== null} onOpenChange={(open) => !open && setWorkerEditor(null)}><SheetContent className="w-full overflow-y-auto sm:max-w-xl"><SheetHeader><SheetTitle>{workerEditor === 'new' ? 'New worker' : 'Edit worker'}</SheetTitle><SheetDescription>PM2 keeps this command running independently from web applications.</SheetDescription></SheetHeader><div className="mt-6 space-y-4"><TextField label="Name" value={workerForm.name} onChange={(name) => setWorkerForm({ ...workerForm, name })} placeholder="Email queue consumer" /><TextField label="Description" value={workerForm.description} onChange={(description) => setWorkerForm({ ...workerForm, description })} placeholder="Optional operator note" /><TextField label="PM2 process name" mono value={workerForm.pm2Name} onChange={(pm2Name) => setWorkerForm({ ...workerForm, pm2Name })} placeholder="worker:email" /><TextField label="Working directory" mono value={workerForm.workingDirectory} onChange={(workingDirectory) => setWorkerForm({ ...workerForm, workingDirectory })} placeholder="C:\web\production\app" /><ScriptField label="Worker command" value={workerForm.command} onChange={(command) => setWorkerForm({ ...workerForm, command })} placeholder="npm run worker:email" /><ToggleField label="Enabled" description="Enabled workers may be started or restarted from Manager." checked={workerForm.enabled} onChange={(enabled) => setWorkerForm({ ...workerForm, enabled })} /><Button className="w-full" disabled={busy === 'save-worker'} onClick={() => void saveWorker()}>{busy === 'save-worker' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save worker</Button></div></SheetContent></Sheet>

      <Sheet open={workerLog !== null} onOpenChange={(open) => !open && setWorkerLog(null)}><SheetContent className="w-full sm:max-w-2xl"><SheetHeader><SheetTitle>{workerLog?.name} logs</SheetTitle><SheetDescription>Recent PM2 output from this worker process.</SheetDescription></SheetHeader><pre className="mt-6 h-[calc(100vh-10rem)] overflow-auto whitespace-pre-wrap rounded-md bg-[#090b0e] p-4 font-mono text-[11px] leading-5 text-slate-300">{workerLog?.output}</pre></SheetContent></Sheet>
    </AppShell>
  )
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="min-w-0"><p className="text-[10px] uppercase text-muted-foreground/70">{label}</p><p className={`mt-1 truncate text-xs ${mono ? 'font-mono' : ''}`}>{value}</p></div> }
function StatusBadge({ status }: { status: CronJob['last_status'] }) { const style = status === 'success' ? 'bg-emerald-500/10 text-emerald-300' : status === 'failed' || status === 'interrupted' ? 'bg-red-500/10 text-red-300' : status === 'running' ? 'bg-cyan-500/10 text-cyan-300' : 'bg-secondary text-muted-foreground'; return <Badge className={style}>{status === 'running' && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{status}</Badge> }
function IconButton({ title, icon, onClick, disabled, danger = false }: { title: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) { return <button title={title} aria-label={title} onClick={onClick} disabled={disabled} className={`flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors disabled:opacity-40 ${danger ? 'text-red-400 hover:bg-red-500/10' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>{icon}</button> }
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="flex min-h-56 flex-col items-center justify-center rounded-md border border-dashed border-border text-center"><div className="mb-3 text-muted-foreground">{icon}</div><p className="text-sm font-medium">{title}</p><p className="mt-1 max-w-sm text-xs text-muted-foreground">{text}</p></div> }
function TextField({ label, value, onChange, placeholder, mono = false, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; mono?: boolean; type?: string }) { return <label className="grid gap-2 text-sm font-medium">{label}<input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={`h-10 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring ${mono ? 'font-mono' : ''}`} /></label> }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) { return <label className="grid gap-2 text-sm font-medium">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring">{options.map((option) => <option key={option}>{option}</option>)}</select></label> }
function ScriptField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) { return <label className="grid gap-2 text-sm font-medium">{label}<textarea rows={6} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-h-32 resize-y rounded-md border border-input bg-[#090b0e] px-3 py-2 font-mono text-sm leading-5 outline-none focus:ring-1 focus:ring-ring" /></label> }
function ToggleField({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="flex items-center justify-between rounded-md border border-border p-3"><div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{description}</p></div><Switch checked={checked} onCheckedChange={onChange} aria-label={label} /></div> }
