import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { controlWorker, WorkerRecord } from '@/lib/workers'

export async function POST(_: Request, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const action = (await context.params).action
    if (!['start', 'stop', 'restart'].includes(action)) throw new ApiError('Invalid worker action', 400)
    await ensureAutomationSchema()
    const { rows } = await query<WorkerRecord>('select * from workers where id = $1', [(await context.params).id])
    if (!rows[0]) throw new ApiError('Worker not found', 404)
    if (!rows[0].enabled && action !== 'stop') throw new ApiError('Enable this worker before starting it', 409)
    const result = await controlWorker(rows[0], action as 'start' | 'stop' | 'restart')
    await audit(user?.id, `worker.${action}`, rows[0].name, { pm2Name: rows[0].pm2_name })
    return NextResponse.json({ ok: true, output: result.output })
  } catch (error) {
    return jsonError(error)
  }
}
