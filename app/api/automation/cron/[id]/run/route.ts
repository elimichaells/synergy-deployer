import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { executeCronJob } from '@/lib/cron-jobs'

export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const result = await executeCronJob(context.params.id, 'manual')
    if (!result.started) {
      const status = result.reason === 'not_found' ? 404 : 409
      return NextResponse.json({ error: result.reason === 'not_found' ? 'Cron job not found' : 'Cron job is already running' }, { status })
    }
    await audit(user?.id, 'cron.run', context.params.id, { trigger: 'manual' })
    return NextResponse.json({ started: true }, { status: 202 })
  } catch (error) {
    return jsonError(error)
  }
}
