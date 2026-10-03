import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { getDatabaseMove } from '@/lib/database-move'

export const dynamic = 'force-dynamic'

/** Progress of a database move, for the page to follow. */
export async function GET(_: Request, context: { params: Promise<{ moveId: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const move = await getDatabaseMove((await context.params).moveId)
    if (!move) throw new ApiError('Move not found', 404)
    return NextResponse.json({ move }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
