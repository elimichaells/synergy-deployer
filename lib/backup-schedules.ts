import { query } from '@/lib/db'
import { createBackup, cleanupDatabaseBackups } from '@/lib/backups'
import { getNextRun, validateTimezone } from '@/lib/cron-jobs'
import { ensureBackupScheduleSchema } from '@/lib/backup-schedule-schema'
import { sendNotification } from '@/lib/notify'

export const BACKUP_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const
export type BackupFrequency = typeof BACKUP_FREQUENCIES[number]

export interface BackupSchedule {
  id: string
  database_name: string
  frequency: BackupFrequency
  time_of_day: string
  timezone: string
  day_of_week: number
  day_of_month: number
  month_of_year: number
  retention_count: number
  enabled: boolean
  next_run_at: string | null
  last_started_at: string | null
  last_finished_at: string | null
  last_status: 'idle' | 'running' | 'success' | 'failed' | 'interrupted'
  last_file: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export function isBackupFrequency(value: unknown): value is BackupFrequency {
  return typeof value === 'string' && BACKUP_FREQUENCIES.includes(value as BackupFrequency)
}

export function validateBackupTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function getBackupCronExpression(schedule: Pick<BackupSchedule, 'frequency' | 'time_of_day' | 'day_of_week' | 'day_of_month' | 'month_of_year'>) {
  if (!validateBackupTime(schedule.time_of_day)) throw new Error('Invalid backup time')
  const [hour, minute] = schedule.time_of_day.split(':').map(Number)
  if (schedule.frequency === 'daily') return `${minute} ${hour} * * *`
  if (schedule.frequency === 'weekly') return `${minute} ${hour} * * ${schedule.day_of_week}`
  if (schedule.frequency === 'monthly') return `${minute} ${hour} ${schedule.day_of_month} * *`
  return `${minute} ${hour} ${schedule.day_of_month} ${schedule.month_of_year} *`
}

export function getNextBackupRun(schedule: Pick<BackupSchedule, 'frequency' | 'time_of_day' | 'timezone' | 'day_of_week' | 'day_of_month' | 'month_of_year'>, currentDate = new Date()) {
  if (!validateTimezone(schedule.timezone)) throw new Error('Invalid timezone')
  return getNextRun(getBackupCronExpression(schedule), schedule.timezone, currentDate)
}

export async function recoverInterruptedBackupSchedules() {
  await ensureBackupScheduleSchema()
  const { rows } = await query<BackupSchedule>(
    `update backup_schedules
       set last_status = 'interrupted', last_finished_at = now(),
           last_error = 'Backup interrupted by Manager restart', next_run_at = null, updated_at = now()
     where last_status = 'running'
     returning *`
  )
  for (const schedule of rows) {
    const nextRun = schedule.enabled ? getNextBackupRun(schedule) : null
    await query('update backup_schedules set next_run_at = $1 where id = $2', [nextRun, schedule.id])
  }
}

export async function executeBackupSchedule(id: string, trigger: 'schedule' | 'manual') {
  await ensureBackupScheduleSchema()
  const { rows } = await query<BackupSchedule>('select * from backup_schedules where id = $1', [id])
  const schedule = rows[0]
  if (!schedule) return { started: false, reason: 'not_found' as const }
  if (trigger === 'schedule' && !schedule.enabled) return { started: false, reason: 'disabled' as const }

  const nextRun = schedule.enabled ? getNextBackupRun(schedule) : null
  const { rows: claimedRows } = await query<BackupSchedule>(
    `update backup_schedules
       set last_status = 'running', last_started_at = now(), last_finished_at = null,
           last_file = null, last_error = null, next_run_at = $1, updated_at = now()
     where id = $2 and last_status <> 'running'
       and ($3::text = 'manual' or (enabled = true and next_run_at <= now()))
     returning *`,
    [nextRun, id, trigger]
  )
  const claimed = claimedRows[0]
  if (!claimed) return { started: false, reason: 'already_running_or_not_due' as const }

  void (async () => {
    try {
      const backup = await createBackup(claimed.database_name)
      await cleanupDatabaseBackups(claimed.database_name, claimed.retention_count)
      await query(
        `update backup_schedules set last_status = 'success', last_finished_at = now(),
           last_file = $1, last_error = null, updated_at = now() where id = $2`,
        [backup.file, claimed.id]
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed'
      await query(
        `update backup_schedules set last_status = 'failed', last_finished_at = now(),
           last_error = $1, updated_at = now() where id = $2`,
        [message.slice(-2000), claimed.id]
      )
      await sendNotification('Scheduled Postgres backup failed', `${claimed.database_name}: ${message}`, 'warning')
    }
  })().catch((error) => console.error(`[backup] Failed to record ${claimed.database_name} schedule result:`, error))

  return { started: true, reason: null }
}

let schedulerBusy = false

export async function backupScheduleTick() {
  if (schedulerBusy) return 1
  schedulerBusy = true
  try {
    await ensureBackupScheduleSchema()
    const { rows: countRows } = await query<{ count: number }>('select count(*)::int as count from backup_schedules')
    const configured = countRows[0]?.count || 0
    if (configured === 0) return 0

    const { rows } = await query<{ id: string }>(
      `select id from backup_schedules
       where enabled = true and next_run_at is not null and next_run_at <= now()
         and last_status <> 'running'
       order by next_run_at asc limit 2`
    )
    await Promise.all(rows.map((schedule) => executeBackupSchedule(schedule.id, 'schedule')))
    return configured
  } catch (error) {
    console.error('[backup] Per-database scheduler tick failed:', error)
    return 1
  } finally {
    schedulerBusy = false
  }
}
