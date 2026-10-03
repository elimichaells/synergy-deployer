import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { restartWithFreshEnvironment } from '@/lib/deploy'
import { appMemory, currentMemorySnapshot, ensureServerMemorySchema } from '@/lib/server-memory'
import { suggestMemoryLimit, validateMemoryLimit } from '@/lib/server-memory-policy'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** This app's memory use, its limit, and a suggested limit. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const memory = await appMemory((await context.params).id)
    if (!memory) throw new ApiError('Application not found', 404)
    return NextResponse.json({ memory: { ...memory, suggestedMb: suggestMemoryLimit(memory.usageMb, memory.peakMb) } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/**
 * Sets or clears the app's memory limit. It takes effect when the app next starts; with
 * `restart: true` the app restarts now and is health-checked.
 */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const body = await request.json().catch(() => null)
    await ensureServerMemorySchema()
    const snapshot = await currentMemorySnapshot(5 * 60_000)
    let limitMb: number | null
    try { limitMb = validateMemoryLimit(body?.limitMb, snapshot.totalMb) } catch (error) { throw new ApiError((error as Error).message, 400) }

    const { rows } = await query<{ previous: number | null }>(
      'with old as (select memory_limit_mb from projects where id=$1) update projects p set memory_limit_mb=$2 from old where p.id=$1 returning old.memory_limit_mb as previous', [id, limitMb])
    if (!rows[0]) throw new ApiError('Application not found', 404)
    await audit(user?.id, 'project.memory_limit_changed', `project:${id}`, { from: rows[0].previous, to: limitMb })

    let restart: { healthy: boolean; reason: string | null } | null = null
    if (body?.restart === true) restart = await restartWithFreshEnvironment(id)
    return NextResponse.json({ limitMb, restart })
  } catch (error) { return jsonError(error) }
}
