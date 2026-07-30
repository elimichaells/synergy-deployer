import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listTables } from '@/lib/db-admin'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: { db: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const tables = await listTables(decodeURIComponent(context.params.db))
    return NextResponse.json({ tables })
  } catch (error) {
    return jsonError(error)
  }
}
