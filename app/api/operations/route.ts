import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { query } from '@/lib/db'
import { readUnifiedHealth } from '@/lib/unified-health'
import { localDiagnosis } from '@/lib/ai-operations-policy'
import { aiSettings, aiHistory, saveAiSettings } from '@/lib/ai-operations-store'
import { diagnoseWithAi } from '@/lib/ai-operations-provider'
import { databaseConfigurationReview } from '@/lib/ai-operations-database'
import { prepareRecovery, executeRecovery, cancelRecovery } from '@/lib/ai-operations-recovery'
import { operationsError, operationsBody, requireSameOrigin, readUptime, uuid } from '@/lib/ai-operations'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const range = new URL(request.url).searchParams.get('range') || '24h'
    if (!['24h', '7d', '30d'].includes(range)) throw new ApiError('Invalid uptime range', 400)
    const [health, settings, history, uptime, apps] = await Promise.all([
      readUnifiedHealth(), aiSettings(), aiHistory(), readUptime(range),
      query('select id,name,pm2_name from projects where is_active=true order by name'),
    ])
    return NextResponse.json({ diagnosis: localDiagnosis(health), settings, history, uptime, apps: apps.rows, role: user!.role,
      checkedAt: health.checkedAt, stale: health.stale || health.unavailable,
      mapping: (health.snapshot?.apps || []).slice(0, 100).map((app, index) => ({ service: `service-${index + 1}`, name: app.name })) },
    { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return operationsError(error) }
}
export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    requireSameOrigin(request)
    const body = await operationsBody(request)
    if (body.action === 'settings') {
      requireRole(user, ['admin'])
      const settings = await saveAiSettings(body)
      await audit(user!.id, 'operations.settings', 'ai', { enabled: settings.enabled, model: settings.model, recoveryEnabled: settings.recoveryEnabled, keyChanged: !!body.apiKey || body.removeKey === true })
      return NextResponse.json({ settings })
    }
    if (body.action === 'diagnose') return NextResponse.json({ diagnosis: await diagnoseWithAi(await readUnifiedHealth(), user!.id) })
    if (body.action === 'database') return NextResponse.json({ database: await databaseConfigurationReview(uuid(body.projectId)) })
    if (body.action === 'prepare-recovery') return NextResponse.json({ review: await prepareRecovery(uuid(body.projectId), user!.id) })
    if (body.action === 'cancel-recovery') return NextResponse.json(await cancelRecovery(uuid(body.reviewId), user!.id))
    if (body.action === 'acknowledge') {
      const changed = await query(`update manager_ai_events set status='reviewed',details=details || jsonb_build_object('reviewedBy',$2::text,'reviewedAt',now())
        where id=$1 and kind='recovery' and (status='failed' or status='running' and created_at<now()-interval '10 minutes') returning id`, [uuid(body.eventId), user!.id])
      if (!changed.rowCount) throw new ApiError('This recovery is not awaiting review', 409)
      return NextResponse.json({ acknowledged: true })
    }
    if (body.action === 'execute-recovery') {
      if (body.confirm !== true) throw new ApiError('Review and explicitly confirm the affected application first', 400)
      return NextResponse.json({ result: await executeRecovery(uuid(body.reviewId), user!.id) })
    }
    throw new ApiError('Unsupported operations action', 400)
  } catch (error) { return operationsError(error) }
}
