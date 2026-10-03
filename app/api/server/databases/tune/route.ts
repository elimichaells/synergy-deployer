import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { tuneDatabaseServer } from '@/lib/database-memory'

export const dynamic = 'force-dynamic'

/** Applies chosen memory settings and restarts the database server. Administrators only. */
export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => null)
    return NextResponse.json({ result: await tuneDatabaseServer(String(body?.connectionId || ''), body?.keys, user?.id) })
  } catch (error) { return jsonError(error) }
}
