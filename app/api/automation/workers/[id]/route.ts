import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { deleteWorkerProcess, validatePm2Name, validateWorkingDirectory, WorkerRecord } from '@/lib/workers'

export async function PATCH(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await ensureAutomationSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)
    const { rows } = await query<WorkerRecord>('select * from workers where id = $1', [context.params.id])
    const current = rows[0]
    if (!current) throw new ApiError('Worker not found', 404)

    const name = typeof body.name === 'string' ? body.name.trim() : current.name
    const description = body.description !== undefined ? body.description?.trim() || null : current.description
    const command = typeof body.command === 'string' ? body.command.trim() : current.command
    const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : current.working_directory
    const pm2Name = typeof body.pm2Name === 'string' ? body.pm2Name.trim() : current.pm2_name
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : current.enabled
    if (!name || !command || !workingDirectory || !pm2Name) throw new ApiError('Required fields cannot be empty', 400)
    validatePm2Name(pm2Name)
    await validateWorkingDirectory(workingDirectory)
    const { rows: updated } = await query<WorkerRecord>(
      `update workers set name = $1, description = $2, command = $3, working_directory = $4,
         pm2_name = $5, enabled = $6, updated_at = now() where id = $7 returning *`,
      [name, description, command, workingDirectory, pm2Name, enabled, context.params.id]
    )
    if (pm2Name !== current.pm2_name) await deleteWorkerProcess(current.pm2_name)
    await audit(user?.id, 'worker.update', name, { pm2Name, enabled })
    return NextResponse.json({ ...updated[0], needsRestart: command !== current.command || workingDirectory !== current.working_directory })
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'Worker name or PM2 name already exists' }, { status: 409 })
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureAutomationSchema()
    const { rows } = await query<WorkerRecord>('select * from workers where id = $1', [context.params.id])
    if (!rows[0]) throw new ApiError('Worker not found', 404)
    await deleteWorkerProcess(rows[0].pm2_name)
    await query('delete from workers where id = $1', [context.params.id])
    await audit(user?.id, 'worker.delete', rows[0].name, { pm2Name: rows[0].pm2_name })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
