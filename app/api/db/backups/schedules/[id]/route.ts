import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { assertDatabase } from '@/lib/db-admin'
import { ensureBackupScheduleSchema } from '@/lib/backup-schedule-schema'
import { BackupSchedule, getNextBackupRun, isBackupFrequency, validateBackupTime } from '@/lib/backup-schedules'

function readInteger(value: unknown, fallback: number, min: number, max: number, label: string) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(`Invalid ${label}`, 400)
  return number
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureBackupScheduleSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)
    const { rows } = await query<BackupSchedule>('select * from backup_schedules where id = $1', [(await context.params).id])
    const current = rows[0]
    if (!current) throw new ApiError('Backup schedule not found', 404)
    if (current.last_status === 'running') throw new ApiError('Wait for the running backup before editing its schedule', 409)

    const database = body.database !== undefined ? String(body.database).trim() : current.database_name
    await assertDatabase(database)
    const frequency = body.frequency !== undefined ? body.frequency : current.frequency
    if (!isBackupFrequency(frequency)) throw new ApiError('Select a backup frequency', 400)
    const timeOfDay = body.timeOfDay !== undefined ? String(body.timeOfDay).trim() : current.time_of_day
    if (!validateBackupTime(timeOfDay)) throw new ApiError('Time must use HH:mm', 400)
    const timezone = body.timezone !== undefined ? String(body.timezone).trim() : current.timezone
    const dayOfWeek = readInteger(body.dayOfWeek, current.day_of_week, 0, 6, 'weekday')
    const dayOfMonth = readInteger(body.dayOfMonth, current.day_of_month, 1, 28, 'day of month')
    const monthOfYear = readInteger(body.monthOfYear, current.month_of_year, 1, 12, 'month')
    const retentionCount = readInteger(body.retentionCount, current.retention_count, 1, 365, 'retention count')
    const enabled = body.enabled !== undefined ? body.enabled === true : current.enabled
    const schedule = { frequency, time_of_day: timeOfDay, timezone, day_of_week: dayOfWeek, day_of_month: dayOfMonth, month_of_year: monthOfYear }
    let nextRun: Date | null
    try {
      nextRun = enabled ? getNextBackupRun(schedule) : null
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Invalid schedule', 400)
    }

    const { rows: updated } = await query<BackupSchedule>(
      `update backup_schedules set database_name=$1, frequency=$2, time_of_day=$3,
         timezone=$4, day_of_week=$5, day_of_month=$6, month_of_year=$7,
         retention_count=$8, enabled=$9, next_run_at=$10, updated_at=now()
       where id=$11 returning *`,
      [database, frequency, timeOfDay, timezone, dayOfWeek, dayOfMonth, monthOfYear, retentionCount, enabled, nextRun, (await context.params).id]
    )
    await audit(user?.id, 'database.backup.schedule.update', database, { frequency, timezone, enabled })
    return NextResponse.json(updated[0])
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'This database already has a backup schedule' }, { status: 409 })
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureBackupScheduleSchema()
    const { rows } = await query<Pick<BackupSchedule, 'database_name' | 'last_status'>>('select database_name,last_status from backup_schedules where id=$1', [(await context.params).id])
    if (!rows[0]) throw new ApiError('Backup schedule not found', 404)
    if (rows[0].last_status === 'running') throw new ApiError('Wait for the running backup before deleting its schedule', 409)
    await query('delete from backup_schedules where id=$1', [(await context.params).id])
    await audit(user?.id, 'database.backup.schedule.delete', rows[0].database_name)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
