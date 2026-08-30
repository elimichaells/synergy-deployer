import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { assertDatabase } from '@/lib/db-admin'
import { ensureBackupScheduleSchema } from '@/lib/backup-schedule-schema'
import { BackupSchedule, getNextBackupRun, isBackupFrequency, validateBackupTime } from '@/lib/backup-schedules'

function numberInRange(value: unknown, fallback: number, min: number, max: number, label: string) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(`Invalid ${label}`, 400)
  return number
}

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureBackupScheduleSchema()
    const { rows } = await query<BackupSchedule>('select * from backup_schedules order by database_name asc')
    return NextResponse.json({ schedules: rows })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureBackupScheduleSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)

    const database = typeof body.database === 'string' ? body.database.trim() : ''
    if (!database) throw new ApiError('Database is required', 400)
    await assertDatabase(database)
    if (!isBackupFrequency(body.frequency)) throw new ApiError('Select a backup frequency', 400)
    const timeOfDay = typeof body.timeOfDay === 'string' ? body.timeOfDay.trim() : '03:00'
    if (!validateBackupTime(timeOfDay)) throw new ApiError('Time must use HH:mm', 400)
    const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC'
    const dayOfWeek = numberInRange(body.dayOfWeek, 0, 0, 6, 'weekday')
    const dayOfMonth = numberInRange(body.dayOfMonth, 1, 1, 28, 'day of month')
    const monthOfYear = numberInRange(body.monthOfYear, 1, 1, 12, 'month')
    const retentionCount = numberInRange(body.retentionCount, 30, 1, 365, 'retention count')
    const enabled = body.enabled !== false
    const schedule = { frequency: body.frequency, time_of_day: timeOfDay, timezone, day_of_week: dayOfWeek, day_of_month: dayOfMonth, month_of_year: monthOfYear }
    let nextRun: Date | null
    try {
      nextRun = enabled ? getNextBackupRun(schedule) : null
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Invalid schedule', 400)
    }

    const { rows } = await query<BackupSchedule>(
      `insert into backup_schedules
        (database_name, frequency, time_of_day, timezone, day_of_week, day_of_month,
         month_of_year, retention_count, enabled, next_run_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [database, body.frequency, timeOfDay, timezone, dayOfWeek, dayOfMonth, monthOfYear, retentionCount, enabled, nextRun, user?.id]
    )
    await audit(user?.id, 'database.backup.schedule.create', database, { frequency: body.frequency, timezone, enabled })
    return NextResponse.json(rows[0], { status: 201 })
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'This database already has a backup schedule' }, { status: 409 })
    return jsonError(error)
  }
}
