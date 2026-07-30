import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { restoreBackup } from '@/lib/backups'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/** Restore a backup file into a NEW database */
export async function POST(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    const file: string = body?.file || ''
    const targetDb: string = (body?.targetDb || '').trim()
    if (!file || !targetDb) {
      return NextResponse.json({ error: 'file and targetDb are required' }, { status: 400 })
    }

    await restoreBackup(file, targetDb)
    await audit(user?.id, 'database.restore', targetDb, { file })

    return NextResponse.json({ ok: true, database: targetDb })
  } catch (error) {
    return jsonError(error)
  }
}
