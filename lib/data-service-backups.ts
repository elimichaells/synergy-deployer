import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, rm, stat } from 'fs/promises'
import path from 'path'
import { ApiError } from '@/lib/api'
import { getNextBackupRun, isBackupFrequency, validateBackupTime, type BackupFrequency } from '@/lib/backup-schedules'
import { query } from '@/lib/db'
import { decryptSecret } from '@/lib/secret-crypto'
import { getSetting } from '@/lib/settings'
import { validateTimezone } from '@/lib/cron-jobs'
import { sendNotification } from '@/lib/notify'

const BACKUP_TIMEOUT_MS = 30 * 60_000

export interface DataServiceBackupSchedule {
  id: string
  service_id: string
  project_id: string
  project_name: string
  environment: string
  service_name: string
  database_name: string
  connection_name: string
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
}

interface BackupTarget {
  id: string
  database_name: string
  username: string
  password_ciphertext: string
  provider: string
  host: string
  port: number
  tls_enabled: boolean
}

export async function ensureDataServiceBackupSchema() {
  await query(`
    create table if not exists data_service_backup_schedules (
      id uuid primary key default gen_random_uuid(),
      service_id uuid unique not null references project_data_services(id) on delete cascade,
      frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
      time_of_day text not null default '03:00', timezone text not null default 'UTC',
      day_of_week integer not null default 0 check (day_of_week between 0 and 6),
      day_of_month integer not null default 1 check (day_of_month between 1 and 28),
      month_of_year integer not null default 1 check (month_of_year between 1 and 12),
      retention_count integer not null default 30 check (retention_count between 1 and 365),
      enabled boolean not null default true, next_run_at timestamptz,
      last_started_at timestamptz, last_finished_at timestamptz,
      last_status text not null default 'idle', last_file text, last_error text,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index if not exists data_service_backup_schedules_due_idx
      on data_service_backup_schedules (next_run_at) where enabled = true
  `)
}

function scheduleNextRun(schedule: Pick<DataServiceBackupSchedule, 'frequency' | 'time_of_day' | 'timezone' | 'day_of_week' | 'day_of_month' | 'month_of_year'>) {
  return getNextBackupRun(schedule)
}

export async function listDataServiceBackupSchedules() {
  await ensureDataServiceBackupSchema()
  const { rows } = await query<DataServiceBackupSchedule>(`
    select dsbs.*,pds.project_id,p.name as project_name,p.environment,pds.name as service_name,
           pds.database_name,dc.name as connection_name
      from data_service_backup_schedules dsbs
      join project_data_services pds on pds.id=dsbs.service_id
      join projects p on p.id=pds.project_id
      join data_connections dc on dc.id=pds.connection_id
     order by p.name,p.environment,pds.name`)
  return rows
}

export async function configureDataServiceBackup(serviceId: string, input: Record<string, unknown>, createdBy?: string | null) {
  await ensureDataServiceBackupSchema()
  const { rows: serviceRows } = await query<{ provider: string }>(
    'select dc.provider from project_data_services pds join data_connections dc on dc.id=pds.connection_id where pds.id=$1',
    [serviceId]
  )
  if (!serviceRows[0]) throw new ApiError('Project data service not found', 404)
  if (serviceRows[0].provider !== 'postgresql') throw new ApiError('Automated project backups currently require PostgreSQL', 400)
  const frequency = input.frequency || 'daily'
  if (!isBackupFrequency(frequency)) throw new ApiError('Select a valid backup frequency', 400)
  const timeOfDay = String(input.timeOfDay || '03:00')
  if (!validateBackupTime(timeOfDay)) throw new ApiError('Backup time must use HH:MM', 400)
  const timezone = String(input.timezone || 'UTC')
  if (!validateTimezone(timezone)) throw new ApiError('Select a valid timezone', 400)
  const dayOfWeek = Number(input.dayOfWeek ?? 0)
  const dayOfMonth = Number(input.dayOfMonth ?? 1)
  const monthOfYear = Number(input.monthOfYear ?? 1)
  const retentionCount = Number(input.retentionCount ?? 30)
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw new ApiError('Weekday must be between 0 and 6', 400)
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) throw new ApiError('Day of month must be between 1 and 28', 400)
  if (!Number.isInteger(monthOfYear) || monthOfYear < 1 || monthOfYear > 12) throw new ApiError('Month must be between 1 and 12', 400)
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) throw new ApiError('Retention must be between 1 and 365 backups', 400)
  const enabled = input.enabled !== false
  const nextRun = enabled ? scheduleNextRun({ frequency, time_of_day: timeOfDay, timezone, day_of_week: dayOfWeek, day_of_month: dayOfMonth, month_of_year: monthOfYear }) : null
  const { rows } = await query<DataServiceBackupSchedule>(`
    insert into data_service_backup_schedules
      (service_id,frequency,time_of_day,timezone,day_of_week,day_of_month,month_of_year,retention_count,enabled,next_run_at,created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (service_id) do update set frequency=excluded.frequency,time_of_day=excluded.time_of_day,
      timezone=excluded.timezone,day_of_week=excluded.day_of_week,day_of_month=excluded.day_of_month,
      month_of_year=excluded.month_of_year,retention_count=excluded.retention_count,enabled=excluded.enabled,
      next_run_at=excluded.next_run_at,updated_at=now()
    returning *`,
    [serviceId, frequency, timeOfDay, timezone, dayOfWeek, dayOfMonth, monthOfYear, retentionCount, enabled, nextRun, createdBy || null]
  )
  return rows[0]
}

async function backupTarget(serviceId: string) {
  const { rows } = await query<BackupTarget>(`
    select pds.id,pds.database_name,pds.username,pds.password_ciphertext,
           dc.provider,dc.host,dc.port,dc.tls_enabled
      from project_data_services pds join data_connections dc on dc.id=pds.connection_id
     where pds.id=$1`, [serviceId])
  const target = rows[0]
  if (!target) throw new Error('Project data service not found')
  if (target.provider !== 'postgresql') throw new Error('Automated project backups currently require PostgreSQL')
  return target
}

async function runTool(exe: string, args: string[], password: string) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, env: { ...process.env, PGPASSWORD: password } })
    let output = ''
    let settled = false
    const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, output }) } }
    const timer = setTimeout(() => { child.kill(); output += '\nBackup timed out'; finish(1) }, BACKUP_TIMEOUT_MS)
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { output += data.toString() })
    child.on('error', (error) => { output += `\n${error.message}`; finish(1) })
    child.on('close', (code) => finish(code ?? 1))
  })
}

async function createDataServiceBackup(serviceId: string, retentionCount: number) {
  const target = await backupTarget(serviceId)
  const root = await getSetting('BACKUP_DIR')
  const directory = path.join(root, 'data-services', serviceId)
  await mkdir(directory, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
  const file = `${target.database_name}__${stamp}.dump`
  const filePath = path.join(directory, file)
  const binPath = await getSetting('PG_BIN_PATH')
  const configured = path.join(binPath, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump')
  const executable = existsSync(configured) ? configured : 'pg_dump'
  const result = await runTool(executable, ['-h', target.host, '-p', String(target.port), '-U', target.username, '-d', target.database_name, '-Fc', '-f', filePath], decryptSecret(target.password_ciphertext))
  if (result.code !== 0) { await rm(filePath, { force: true }).catch(() => undefined); throw new Error(`pg_dump failed: ${result.output.slice(-800) || 'unknown error'}`) }
  const entries = await readdir(directory)
  const files = await Promise.all(entries.filter((entry) => entry.endsWith('.dump')).map(async (entry) => ({ entry, info: await stat(path.join(directory, entry)) })))
  files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
  for (const old of files.slice(retentionCount)) await rm(path.join(directory, old.entry), { force: true })
  return path.join('data-services', serviceId, file)
}

export async function executeDataServiceBackup(id: string, trigger: 'schedule' | 'manual') {
  await ensureDataServiceBackupSchema()
  const { rows } = await query<DataServiceBackupSchedule>('select * from data_service_backup_schedules where id=$1', [id])
  const schedule = rows[0]
  if (!schedule) return { started: false, reason: 'not_found' as const }
  const nextRun = schedule.enabled ? scheduleNextRun(schedule) : null
  const { rows: claimedRows } = await query<DataServiceBackupSchedule>(`
    update data_service_backup_schedules set last_status='running',last_started_at=now(),last_finished_at=null,
      last_file=null,last_error=null,next_run_at=$1,updated_at=now()
     where id=$2 and last_status<>'running'
       and ($3::text='manual' or (enabled=true and next_run_at<=now())) returning *`, [nextRun, id, trigger])
  const claimed = claimedRows[0]
  if (!claimed) return { started: false, reason: 'already_running_or_not_due' as const }
  void (async () => {
    try {
      const file = await createDataServiceBackup(claimed.service_id, claimed.retention_count)
      await query("update data_service_backup_schedules set last_status='success',last_finished_at=now(),last_file=$1,last_error=null,updated_at=now() where id=$2", [file, claimed.id])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Backup failed'
      await query("update data_service_backup_schedules set last_status='failed',last_finished_at=now(),last_error=$1,updated_at=now() where id=$2", [message.slice(-2000), claimed.id])
      await sendNotification('Project database backup failed', message, 'warning')
    }
  })().catch((error) => console.error('[backup] Failed to record project database result:', error))
  return { started: true, reason: null }
}

let schedulerBusy = false
export async function dataServiceBackupSchedulerTick() {
  if (schedulerBusy) return
  schedulerBusy = true
  try {
    await ensureDataServiceBackupSchema()
    const { rows } = await query<{ id: string }>(`select id from data_service_backup_schedules where enabled=true and next_run_at<=now() and last_status<>'running' order by next_run_at limit 2`)
    await Promise.all(rows.map((schedule) => executeDataServiceBackup(schedule.id, 'schedule')))
  } finally { schedulerBusy = false }
}

export async function recoverInterruptedDataServiceBackups() {
  await ensureDataServiceBackupSchema()
  const { rows } = await query<DataServiceBackupSchedule>("update data_service_backup_schedules set last_status='interrupted',last_finished_at=now(),last_error='Backup interrupted by Manager restart',updated_at=now() where last_status='running' returning *")
  for (const schedule of rows) await query('update data_service_backup_schedules set next_run_at=$1 where id=$2', [schedule.enabled ? scheduleNextRun(schedule) : null, schedule.id])
}
