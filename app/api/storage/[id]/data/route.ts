import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listTables } from '@/lib/db-admin'
import { explorerTarget } from '@/lib/storage'

export const dynamic = 'force-dynamic'

/** The tables in a database, for the Data tab. */
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const { database, target } = await explorerTarget((await context.params).id)
    return NextResponse.json({ tables: await listTables(database, target) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
