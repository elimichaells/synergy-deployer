import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { requestDeployCancel } from '@/lib/deploy'

export async function POST(_request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const deploymentId = context.params.id
    const { rows } = await query<{ id: string; status: string }>(
      'SELECT id, status FROM deployments WHERE id = $1',
      [deploymentId]
    )
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }
    if (rows[0].status !== 'running') {
      return NextResponse.json({ error: 'Deployment is not running' }, { status: 400 })
    }

    // Flag the in-process deploy loop — it aborts at the next step boundary.
    requestDeployCancel(deploymentId)

    // Also mark it failed in the DB so the UI unblocks even if the loop is gone
    // (e.g. the manager restarted and the deployment is orphaned).
    await query(
      `UPDATE deployments
       SET status = 'failed', finished_at = now(),
           log = COALESCE(log, '') || $1
       WHERE id = $2 AND status = 'running'`,
      [`\n[cancelled] Deployment cancelled by ${user?.email || 'user'}\n`, deploymentId]
    )

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
