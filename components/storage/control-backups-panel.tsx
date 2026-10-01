'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, HardDriveDownload, Loader2, Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/app/section'
import { relativeTime } from '@/lib/deployment-stages'
import { formatBytes } from '@/lib/format'
import { ScheduleSheet, type ScheduleValues } from './schedule-sheet'

interface Schedule {
  id: string; database_name: string; frequency: string; time_of_day: string; timezone: string; day_of_week: number; day_of_month: number; month_of_year: number
  retention_count: number; enabled: boolean; next_run_at: string | null; last_finished_at: string | null; last_status: string; last_error: string | null
}
interface BackupFile { file: string; database: string; size_bytes: number; created_at: string }

const asValues = (schedule: Schedule): ScheduleValues => ({ enabled: schedule.enabled, frequency: schedule.frequency, timeOfDay: schedule.time_of_day, timezone: schedule.timezone, dayOfWeek: schedule.day_of_week, dayOfMonth: schedule.day_of_month, monthOfYear: schedule.month_of_year, retentionCount: schedule.retention_count })

/**
 * Backups for a database on Synergy's own PostgreSQL server. These use the server-wide backup
 * system, which keeps one flat folder of dumps and can restore into a new database.
 */
export function ControlBackupsPanel({ database, isAdmin }: { database: string; isAdmin: boolean }) {
  const [schedule, setSchedule] = useState<Schedule | null | undefined>(undefined)
  const [files, setFiles] = useState<BackupFile[]>([])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const [backups, schedules] = await Promise.all([fetch('/api/db/backups', { cache: 'no-store' }), fetch('/api/db/backups/schedules', { cache: 'no-store' })])
    if (!backups.ok || !schedules.ok) throw new Error('Could not load the backups')
    setFiles(((await backups.json()).backups as BackupFile[]).filter(item => item.database === database))
    setSchedule(((await schedules.json()).schedules as Schedule[]).find(item => item.database_name === database) || null)
    setNow(Date.now())
  }, [database])
  useEffect(() => { void load().catch(err => { setError((err as Error).message); setSchedule(null) }) }, [load])

  const act = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNotice('')
    try { const message = await action(); if (message) setNotice(message); await load() } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }
  const call = async (url: string, init: RequestInit, failure: string) => {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || failure)
    return body
  }

  const backupNow = () => act('now', async () => {
    const body = await call('/api/db/backups', { method: 'POST', body: JSON.stringify({ database }) }, 'The backup failed')
    return `Backed up ${database} (${formatBytes(body.size_bytes)}).`
  })
  const restore = (file: string) => {
    const suggestion = `${database}_restored_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
    const target = window.prompt(`Restore ${file} into a NEW database. Nothing that is running changes. Name for the new database:`, suggestion)?.trim()
    if (!target) return
    void act(`restore-${file}`, async () => { await call('/api/db/backups/restore', { method: 'POST', body: JSON.stringify({ file, targetDb: target }) }, 'Restore failed'); return `Restored into the new database ${target}.` })
  }
  const remove = (file: string) => {
    if (!window.confirm(`Delete the backup ${file}? This cannot be undone.`)) return
    void act(`delete-${file}`, async () => { await call('/api/db/backups', { method: 'DELETE', body: JSON.stringify({ file }) }, 'Could not delete the backup') })
  }

  if (schedule === undefined) return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading backups…</div>

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="notice-error">{error}</div>}
      {notice && <p role="status" className="rounded-md border border-status-ready/25 bg-status-ready/5 px-4 py-3 text-sm text-emerald-200">{notice}</p>}
      <Section title="Schedule" description="Backups are compressed PostgreSQL dumps stored on this server."
        action={<div className="flex gap-2">
          {schedule && <Button size="sm" variant="outline" onClick={() => void act('run', async () => { await call(`/api/db/backups/schedules/${schedule.id}/run`, { method: 'POST' }, 'The backup could not start'); return 'Backup started. It appears in the list when it finishes.' })} disabled={!isAdmin || busy !== null || schedule.last_status === 'running'}>{busy === 'run' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}Run schedule now</Button>}
          <Button size="sm" variant="outline" onClick={() => void backupNow()} disabled={!isAdmin || busy !== null}>{busy === 'now' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <HardDriveDownload className="mr-1.5 h-3.5 w-3.5" />}Back up now</Button>
        </div>}
        footer={<><span>Oldest backups are deleted automatically once the limit is reached.</span><Button size="sm" onClick={() => setEditing(true)} disabled={!isAdmin}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />{schedule ? 'Edit schedule' : 'Schedule backups'}</Button></>}>
        {schedule ? (
          <dl className="summary-list">
            <div><dt>Frequency</dt><dd className="capitalize">{schedule.frequency} at {schedule.time_of_day} {schedule.timezone}{schedule.enabled ? '' : ' (paused)'}</dd></div>
            <div><dt>Last backup</dt><dd>{schedule.last_finished_at ? `${relativeTime(schedule.last_finished_at, now)} · ${schedule.last_status}` : schedule.last_status === 'running' ? 'Running now' : 'Not run yet'}</dd></div>
            <div><dt>Next backup</dt><dd>{schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : '—'}</dd></div>
            <div><dt>Keeps</dt><dd>{schedule.retention_count} backups</dd></div>
          </dl>
        ) : <p className="text-sm text-muted-foreground">No backups are scheduled for this database.</p>}
        {schedule?.last_error && <p className="mt-3 text-xs text-red-300">Last error: {schedule.last_error}</p>}
      </Section>
      <Section title="Backup files" description="Restoring creates a new database next to this one, so nothing running is affected. Check the data, then point the app at it.">
        {files.length ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {files.map(file => (
              <div key={file.file} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <HardDriveDownload className="h-4 w-4 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs">{file.file}</span><span className="block text-xs text-muted-foreground">{new Date(file.created_at).toLocaleString()} · {formatBytes(file.size_bytes)}</span></span>
                {isAdmin && <>
                  <Button asChild size="sm" variant="ghost" aria-label={`Download ${file.file}`}><a href={`/api/db/backups/download?file=${encodeURIComponent(file.file)}`}><Download className="h-3.5 w-3.5" /></a></Button>
                  <Button size="sm" variant="outline" onClick={() => restore(file.file)} disabled={busy !== null}>{busy === `restore-${file.file}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}Restore to new database</Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${file.file}`} onClick={() => remove(file.file)} disabled={busy !== null}>{busy === `delete-${file.file}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</Button>
                </>}
              </div>
            ))}
          </div>
        ) : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No backup files yet.</p>}
      </Section>
      <ScheduleSheet target={{ kind: 'control', database, scheduleId: schedule?.id }} initial={schedule ? asValues(schedule) : null} open={editing} onOpenChange={setEditing} onSaved={() => void load().catch(() => undefined)} />
    </div>
  )
}
