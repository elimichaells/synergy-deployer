import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { memoryOverview } from '@/lib/server-memory'

export const dynamic = 'force-dynamic'

/** What uses the server's memory now, the last day of free memory, and memory warnings. */
export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json(await memoryOverview(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
