import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { listWorkers, validatePm2Name, validateWorkingDirectory, WorkerRecord } from '@/lib/workers'

export async function GET() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json(await listWorkers())
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await ensureAutomationSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    const workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory.trim() : ''
    const pm2Name = typeof body.pm2Name === 'string' ? body.pm2Name.trim() : ''
    if (!name || !command || !workingDirectory || !pm2Name) throw new ApiError('Name, command, working directory, and PM2 name are required', 400)
    if (name.length > 120 || command.length > 8000) throw new ApiError('Worker definition is too long', 400)
    validatePm2Name(pm2Name)
    await validateWorkingDirectory(workingDirectory)

    const { rows } = await query<WorkerRecord>(
      `insert into workers (name, description, command, working_directory, pm2_name, enabled, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [name, body.description?.trim() || null, command, workingDirectory, pm2Name, body.enabled !== false, user?.id]
    )
    await audit(user?.id, 'worker.create', name, { pm2Name })
    return NextResponse.json(rows[0], { status: 201 })
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'Worker name or PM2 name already exists' }, { status: 409 })
    return jsonError(error)
  }
}
