import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { ensureServerMemorySchema } from '@/lib/server-memory'
import { setStagingSleep } from '@/lib/staging-sleep'
import { validateSleepAfter } from '@/lib/staging-sleep-policy'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** Whether this staging app sleeps when idle, and whether it is asleep now. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    await ensureServerMemorySchema()
    const { rows } = await query<{ environment: string | null; sleep_after_minutes: number | null; sleeping_since: Date | null; last_active_at: Date | null }>(
      'select environment, sleep_after_minutes, sleeping_since, last_active_at from projects where id=$1', [(await context.params).id])
    if (!rows[0]) throw new ApiError('Application not found', 404)
    return NextResponse.json({ sleep: rows[0] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const body = await request.json().catch(() => null)
    let minutes: number | null
    try { minutes = validateSleepAfter(body?.minutes) } catch (error) { throw new ApiError((error as Error).message, 400) }
    await ensureServerMemorySchema()
    const result = await setStagingSleep((await context.params).id, minutes, user?.id)
    return NextResponse.json({ minutes, ...result })
  } catch (error) { return jsonError(error) }
}
