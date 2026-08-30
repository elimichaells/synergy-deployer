import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { query } from '@/lib/db'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { CronJob, getNextRun, isCronLanguage } from '@/lib/cron-jobs'
import { validateWorkingDirectory } from '@/lib/workers'

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(`${label} is required`, 400)
  if (value.length > max) throw new ApiError(`${label} is too long`, 400)
  return value.trim()
}

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    await ensureAutomationSchema()
    const { rows } = await query<CronJob>(
      `select c.*, p.name as project_name, p.project_type
       from cron_jobs c
       left join projects p on p.id = c.project_id
       order by p.name nulls last, c.name asc`
    )
    return NextResponse.json(rows)
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await ensureAutomationSchema()
    const body = await request.json().catch(() => null)
    if (!body) throw new ApiError('Invalid payload', 400)

    const name = requiredText(body.name, 'Name', 120)
    const projectId = requiredText(body.projectId, 'Project', 100)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) throw new ApiError('Invalid project', 400)
    if (!isCronLanguage(body.language)) throw new ApiError('Select a supported language or framework', 400)
    const { rows: projectRows } = await query<{ id: string; root_path: string; name: string }>(
      'select id, root_path, name from projects where id = $1',
      [projectId]
    )
    const project = projectRows[0]
    if (!project) throw new ApiError('Project not found', 404)
    const schedule = requiredText(body.schedule, 'Schedule', 100)
    const timezone = requiredText(body.timezone || 'UTC', 'Timezone', 100)
    const command = requiredText(body.command, 'Command', 8000)
    if (process.platform === 'win32' && /(?:^|\s)\/?dev\/null(?:\s|$)/i.test(command)) {
      throw new ApiError('Remove /dev/null redirection. Manager captures cron output automatically on Windows.', 400)
    }
    const workingDirectory = project.root_path
    const timeoutSeconds = Number(body.timeoutSeconds || 300)
    const enabled = body.enabled !== false
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
      throw new ApiError('Timeout must be between 1 and 86400 seconds', 400)
    }
    await validateWorkingDirectory(workingDirectory)
    let nextRun: Date | null = null
    try {
      nextRun = enabled ? getNextRun(schedule, timezone) : null
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'Invalid schedule', 400)
    }

    const { rows } = await query<CronJob>(
      `insert into cron_jobs
        (project_id, language, name, description, schedule, timezone, command, working_directory, timeout_seconds, enabled, next_run_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning *`,
      [projectId, body.language, name, body.description?.trim() || null, schedule, timezone, command, workingDirectory, timeoutSeconds, enabled, nextRun, user?.id]
    )
    await audit(user?.id, 'cron.create', name, { projectId, language: body.language, schedule, timezone, enabled })
    return NextResponse.json(rows[0], { status: 201 })
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') return NextResponse.json({ error: 'A cron job with this name already exists' }, { status: 409 })
    return jsonError(error)
  }
}
