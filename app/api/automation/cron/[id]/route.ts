import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { CronJob, getNextRun, isCronLanguage } from '@/lib/cron-jobs'
import { validateWorkingDirectory } from '@/lib/workers'

export async function PATCH(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await ensureAutomationSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)
    const { rows } = await query<CronJob>('select * from cron_jobs where id = $1', [context.params.id])
    const current = rows[0]
    if (!current) throw new ApiError('Cron job not found', 404)

    const name = typeof body.name === 'string' ? body.name.trim() : current.name
    const projectId = body.projectId !== undefined ? String(body.projectId).trim() : current.project_id
    if (!projectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) throw new ApiError('Select a valid project', 400)
    const language = body.language !== undefined ? body.language : current.language
    if (!isCronLanguage(language)) throw new ApiError('Select a supported language or framework', 400)
    const { rows: projectRows } = await query<{ id: string; root_path: string }>(
      'select id, root_path from projects where id = $1',
      [projectId]
    )
    const project = projectRows[0]
    if (!project) throw new ApiError('Project not found', 404)
    const description = body.description !== undefined ? body.description?.trim() || null : current.description
    const schedule = typeof body.schedule === 'string' ? body.schedule.trim() : current.schedule
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : current.timezone
    const command = typeof body.command === 'string' ? body.command.trim() : current.command
    if (process.platform === 'win32' && /(?:^|\s)\/?dev\/null(?:\s|$)/i.test(command)) {
      throw new ApiError('Remove /dev/null redirection. Manager captures cron output automatically on Windows.', 400)
    }
    const workingDirectory = project.root_path
    const timeoutSeconds = body.timeoutSeconds !== undefined ? Number(body.timeoutSeconds) : current.timeout_seconds
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : current.enabled
    if (!name || !schedule || !command || !workingDirectory) throw new ApiError('Name, schedule, command, and working directory are required', 400)
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new ApiError('Invalid timeout', 400)
    await validateWorkingDirectory(workingDirectory)
    let nextRun: Date | null = null
    try {
      nextRun = enabled ? getNextRun(schedule, timezone) : null
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Invalid schedule', 400)
    }

    const { rows: updated } = await query<CronJob>(
      `update cron_jobs set project_id = $1, language = $2, name = $3, description = $4,
         schedule = $5, timezone = $6, command = $7, working_directory = $8,
         timeout_seconds = $9, enabled = $10, next_run_at = $11, updated_at = now()
       where id = $12 returning *`,
      [projectId, language, name, description, schedule, timezone, command, workingDirectory, timeoutSeconds, enabled, nextRun, context.params.id]
    )
    await audit(user?.id, 'cron.update', name, { projectId, language, schedule, timezone, enabled })
    return NextResponse.json(updated[0])
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'A cron job with this name already exists' }, { status: 409 })
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    await ensureAutomationSchema()
    const { rows: current } = await query<Pick<CronJob, 'name' | 'last_status'>>(
      'select name, last_status from cron_jobs where id = $1',
      [context.params.id]
    )
    if (!current[0]) throw new ApiError('Cron job not found', 404)
    if (current[0].last_status === 'running') throw new ApiError('Stop or wait for the running job before deleting it', 409)
    const { rows } = await query<{ name: string }>('delete from cron_jobs where id = $1 returning name', [context.params.id])
    await audit(user?.id, 'cron.delete', rows[0].name)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
