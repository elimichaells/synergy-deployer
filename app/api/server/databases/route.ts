import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { inspectDatabaseServers } from '@/lib/database-memory'

export const dynamic = 'force-dynamic'

/** Each database server on this machine: memory, data, connections and settings worth changing. */
export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ servers: await inspectDatabaseServers(), canTune: user?.role === 'admin' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
