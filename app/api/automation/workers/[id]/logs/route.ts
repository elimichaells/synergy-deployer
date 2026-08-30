import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { validatePm2Name, WorkerRecord } from '@/lib/workers'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    await ensureAutomationSchema()
    const { rows } = await query<WorkerRecord>('select * from workers where id = $1', [(await context.params).id])
    if (!rows[0]) throw new ApiError('Worker not found', 404)
    validatePm2Name(rows[0].pm2_name)
    const result = await runCommand(`pm2 logs "${rows[0].pm2_name}" --lines 100 --nostream`, undefined, 15_000)
    return NextResponse.json({ output: result.output, exitCode: result.code })
  } catch (error) {
    return jsonError(error)
  }
}
