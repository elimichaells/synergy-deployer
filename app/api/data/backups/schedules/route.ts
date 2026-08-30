import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { configureDataServiceBackup, listDataServiceBackupSchedules } from '@/lib/data-service-backups'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ schedules: await listDataServiceBackupSchedules() })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json()
    const schedule = await configureDataServiceBackup(String(body.serviceId || ''), body, user?.id)
    await audit(user?.id, 'project.data-service.backup.configure', schedule.service_id, { frequency: schedule.frequency, enabled: schedule.enabled })
    return NextResponse.json({ schedule })
  } catch (error) { return jsonError(error) }
}
