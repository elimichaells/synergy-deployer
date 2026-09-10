import { CronExpressionParser } from 'cron-parser'
import { db, query } from '@/lib/db'
import { ensureDeploymentSchema } from '@/lib/deployment-schema'
import { runCommand } from '@/lib/exec'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { projectRuntimeEnvironment } from '@/lib/runtimes'

export interface CronJob {
  id: string
  project_id: string | null
  project_name?: string | null
  project_type?: string | null
  name: string
  description: string | null
  language: CronLanguage
  schedule: string
  timezone: string
  command: string
  working_directory: string
  timeout_seconds: number
  enabled: boolean
  next_run_at: string | null
  last_started_at: string | null
  last_finished_at: string | null
  last_status: 'idle' | 'running' | 'success' | 'failed' | 'interrupted'
  last_exit_code: number | null
  last_output: string | null
  created_at: string
  updated_at: string
}

export const CRON_LANGUAGES = ['laravel', 'php', 'node', 'python', 'go', 'custom'] as const
export type CronLanguage = typeof CRON_LANGUAGES[number]

export function isCronLanguage(value: unknown): value is CronLanguage {
  return typeof value === 'string' && CRON_LANGUAGES.includes(value as CronLanguage)
}

const MAX_STORED_OUTPUT = 100_000
let schedulerBusy = false

export function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}

export function getNextRun(schedule: string, timezone: string, currentDate = new Date()) {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error('Use a standard five-field cron expression: minute hour day month weekday')
  }
  if (!validateTimezone(timezone)) throw new Error('Invalid timezone')
  return CronExpressionParser.parse(schedule, { currentDate, tz: timezone }).next().toDate()
}

export async function recoverInterruptedCronJobs() {
  await ensureAutomationSchema()
  await ensureDeploymentSchema()
  const { rows } = await query<CronJob>(
    `update cron_jobs
       set last_status = 'interrupted', last_finished_at = now(),
           last_output = coalesce(last_output, '') || E'\n[manager] Job interrupted by Manager restart.',
           next_run_at = null, updated_at = now()
     where last_status = 'running'
     returning *`
  )

  for (const job of rows) {
    const nextRun = job.enabled ? getNextRun(job.schedule, job.timezone) : null
    await query('update cron_jobs set next_run_at = $1 where id = $2', [nextRun, job.id])
  }
}

export async function executeCronJob(id: string, trigger: 'schedule' | 'manual') {
  await ensureAutomationSchema()
  await ensureDeploymentSchema()
  const { rows } = await query<CronJob>('select * from cron_jobs where id = $1', [id])
  const job = rows[0]
  if (!job) return { started: false, reason: 'not_found' as const }
  if (trigger === 'schedule' && !job.enabled) return { started: false, reason: 'disabled' as const }

  const nextRun = job.enabled ? getNextRun(job.schedule, job.timezone) : null
  const client = await db.connect()
  let claimedRows: CronJob[]
  try {
    await client.query('begin')
    const owners = job.project_id ? [job.project_id] : (await client.query<{ id: string }>('select id from projects where lower(root_path)=lower($1) order by id', [job.working_directory])).rows.map(row => row.id)
    for (const owner of owners) await client.query("select pg_advisory_xact_lock(hashtext('manager-activation'),hashtext($1))", [owner])
    const claimed = await client.query<CronJob>(
    `update cron_jobs
       set last_status = 'running', last_started_at = now(), last_finished_at = null,
           last_exit_code = null, last_output = '', next_run_at = $1, updated_at = now()
     where id = $2 and last_status <> 'running'
       and not exists (select 1 from deployments d join projects p on p.id=d.project_id
         where d.status='running' and d.phase in ('activate','health')
           and (d.project_id=cron_jobs.project_id or lower(p.root_path)=lower(cron_jobs.working_directory)))
       and ($3::text = 'manual' or (enabled = true and next_run_at <= now()))
     returning *`,
    [nextRun, id, trigger]
  )
    claimedRows = claimed.rows
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  const claimed = claimedRows[0]
  if (!claimed) return { started: false, reason: 'already_running_or_not_due' as const }

  void (async () => {
    let workingDirectory = claimed.working_directory
    let runtimeEnvironment: Record<string, string> = {}
    if (claimed.project_id) {
      const { rows: projectRows } = await query<{ root_path: string; runtime_versions: Record<string, string> }>(
        'select root_path,runtime_versions from projects where id = $1',
        [claimed.project_id]
      )
      if (!projectRows[0]) throw new Error('Cron project no longer exists')
      workingDirectory = projectRows[0].root_path
      runtimeEnvironment = projectRuntimeEnvironment(projectRows[0].runtime_versions)
      if (workingDirectory !== claimed.working_directory) {
        await query('update cron_jobs set working_directory = $1, updated_at = now() where id = $2', [workingDirectory, claimed.id])
      }
    }
    const result = await runCommand(
      claimed.command,
      workingDirectory,
      claimed.timeout_seconds * 1000,
      undefined,
      runtimeEnvironment,
      false,
    )
    const output = result.output.length > MAX_STORED_OUTPUT
      ? `[output truncated]\n${result.output.slice(-MAX_STORED_OUTPUT)}`
      : result.output
    await query(
      `update cron_jobs
         set last_status = $1, last_finished_at = now(), last_exit_code = $2,
             last_output = $3, updated_at = now()
       where id = $4`,
      [result.code === 0 ? 'success' : 'failed', result.code, output, claimed.id]
    )
  })().catch((error) => console.error(`[cron] ${claimed.name} failed to record result:`, error))

  return { started: true, reason: null }
}

export async function cronSchedulerTick() {
  if (schedulerBusy) return
  schedulerBusy = true
  try {
    await ensureAutomationSchema()
    const { rows } = await query<{ id: string }>(
      `select id from cron_jobs
       where enabled = true and next_run_at is not null and next_run_at <= now()
         and last_status <> 'running'
       order by next_run_at asc
       limit 10`
    )
    await Promise.all(rows.map((job) => executeCronJob(job.id, 'schedule')))
  } catch (error) {
    console.error('[cron] Scheduler tick failed:', error)
  } finally {
    schedulerBusy = false
  }
}
