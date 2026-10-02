import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { startDeploy } from '@/lib/deploy'
import { getGateState, getOverridePlan, overrideDeployment, turnGateOff } from '@/lib/security-gate'
import { validateGateOverride } from '@/lib/security-gate-policy'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** What deploying past the gate would release, shown before an administrator confirms. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const plan = await getOverridePlan((await context.params).id)
    return NextResponse.json({ plan, gate: await getGateState(plan.projectId), canOverride: user?.role === 'admin' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/**
 * Releases a deployment the security gate stopped. Administrators only: it needs a reason and an
 * explicit acknowledgement, and it is written to the audit log and into the deployment's own log.
 */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const deploymentId = (await context.params).id
    const body = await request.json().catch(() => null)
    let override: ReturnType<typeof validateGateOverride>
    try { override = validateGateOverride(body) } catch (error) { throw new ApiError((error as Error).message, 400) }

    const plan = await getOverridePlan(deploymentId)
    if (plan.blocker) throw new ApiError(plan.blocker, 409)
    // A promotion releases what staging runs; the caller confirms the commit it was shown.
    if (plan.kind === 'promote' && body?.commit !== plan.staging?.commit) {
      throw new ApiError('Staging changed since you opened this. Review what will be released and confirm again.', 409)
    }

    const { project, options } = await overrideDeployment(plan, user?.id, override.reason)
    const started = await startDeploy(project, options)
    if (!started) throw new ApiError('A deployment is already running for this app', 409)
    // The longer-lived switch is stored only once the release has actually started.
    if (override.scope !== 'once') await turnGateOff(plan.projectId, user?.id, override.scope, override.reason)
    await audit(user?.id, 'deployment.security_gate_overridden', `project:${plan.projectId}`,
      { deployment: started, blocked: deploymentId, scope: override.scope, reason: override.reason, kind: plan.kind, commit: plan.staging?.commit })
    return NextResponse.json({ deploymentId: started, status: 'running' })
  } catch (error) { return jsonError(error) }
}
