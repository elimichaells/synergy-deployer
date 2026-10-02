import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { getGateState, turnGateOff, turnGateOn } from '@/lib/security-gate'
import { validateGateOverride } from '@/lib/security-gate-policy'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** Whether this app's dependency security gate is switched off, by whom and why. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const gate = await getGateState((await context.params).id)
    if (!gate) throw new ApiError('Application not found', 404)
    return NextResponse.json({ gate, canTurnOff: user?.role === 'admin' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/**
 * Turning the gate back on is the safe direction, so operators may do it. Turning it off lets
 * releases with known vulnerabilities go live, so only an administrator may, with a reason.
 */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const body = await request.json().catch(() => null)
    if (body?.enforce === true) {
      await turnGateOn(id, user?.id)
    } else {
      requireRole(user, ['admin'])
      let override: ReturnType<typeof validateGateOverride>
      try { override = validateGateOverride(body) } catch (error) { throw new ApiError((error as Error).message, 400) }
      if (override.scope === 'once') throw new ApiError('Choose how long the security gate stays off for this app', 400)
      await turnGateOff(id, user?.id, override.scope, override.reason)
    }
    return NextResponse.json({ gate: await getGateState(id) })
  } catch (error) { return jsonError(error) }
}
