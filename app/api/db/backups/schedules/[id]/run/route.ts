import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { executeBackupSchedule } from '@/lib/backup-schedules'

export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    const result = await executeBackupSchedule(context.params.id, 'manual')
    if (!result.started) {
      return NextResponse.json({ error: result.reason === 'not_found' ? 'Backup schedule not found' : 'Backup is already running' }, { status: result.reason === 'not_found' ? 404 : 409 })
    }
    await audit(user?.id, 'database.backup.schedule.run', context.params.id)
    return NextResponse.json({ started: true }, { status: 202 })
  } catch (error) {
    return jsonError(error)
  }
}
