import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listTables } from '@/lib/db-admin'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ db: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const tables = await listTables(decodeURIComponent((await context.params).db))
    return NextResponse.json({ tables })
  } catch (error) {
    return jsonError(error)
  }
}
