import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { restoreToNewDatabase } from '@/lib/storage'

export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const body = await request.json().catch(() => ({}))
    const result = await restoreToNewDatabase(id, body.file)
    await audit(user?.id, 'storage.restore', id, { file: body.file, database: result.database })
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
