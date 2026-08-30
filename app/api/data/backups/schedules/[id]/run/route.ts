import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { executeDataServiceBackup } from '@/lib/data-service-backups'
import { requireRole } from '@/lib/rbac'

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const result = await executeDataServiceBackup(id, 'manual')
    await audit(user?.id, 'project.data-service.backup.run', id)
    return NextResponse.json(result, { status: result.started ? 202 : 409 })
  } catch (error) { return jsonError(error) }
}
