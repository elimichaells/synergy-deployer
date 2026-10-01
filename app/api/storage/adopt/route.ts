import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { adoptDatabase } from '@/lib/storage'

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => ({}))
    const result = await adoptDatabase(String(body.projectId || ''), body.source, user?.id)
    await audit(user?.id, 'storage.link', String(body.projectId || ''), { source: body.source, database: result.database })
    return NextResponse.json(result, { status: 201 })
  } catch (error) { return jsonError(error) }
}
