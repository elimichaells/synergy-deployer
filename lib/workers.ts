import path from 'path'
import { stat } from 'fs/promises'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { ensureAutomationSchema } from '@/lib/automation-schema'
import { ApiError } from '@/lib/api'
import { projectRuntimeEnvironment } from '@/lib/runtimes'

export interface WorkerRecord {
  id: string
  name: string
  description: string | null
  command: string
  working_directory: string
  pm2_name: string
  enabled: boolean
  created_at: string
  updated_at: string
}

const WORKER_RUNNER = path.join(process.cwd(), 'scripts', 'pm2-worker-runner.js')
const PM2_NAME_PATTERN = /^[a-zA-Z0-9._:-]+$/

export function validatePm2Name(name: string) {
  if (!PM2_NAME_PATTERN.test(name) || name.length > 100) {
    throw new ApiError('PM2 name may contain letters, numbers, dots, underscores, colons, and hyphens', 400)
  }
}

export async function validateWorkingDirectory(directory: string) {
  if (!path.isAbsolute(directory)) throw new ApiError('Working directory must be an absolute path', 400)
  const info = await stat(directory).catch(() => null)
  if (!info?.isDirectory()) throw new ApiError('Working directory does not exist', 400)
}

export async function listWorkers() {
  await ensureAutomationSchema()
  const [{ rows }, pm2] = await Promise.all([
    query<WorkerRecord>('select * from workers order by name asc'),
    runCommand('pm2 jlist'),
  ])
  let processes: Array<{
    name: string
    pid?: number
    pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number }
    monit?: { cpu?: number; memory?: number }
  }> = []
  if (pm2.code === 0) {
    try {
      processes = JSON.parse(pm2.output)
    } catch {
      console.error('[workers] Failed to parse PM2 process list')
    }
  }

  return rows.map((worker) => {
    const process = processes.find((item) => item.name === worker.pm2_name)
    return {
      ...worker,
      status: process?.pm2_env?.status || 'not_started',
      pid: process?.pid || null,
      uptime: process?.pm2_env?.pm_uptime || null,
      restarts: process?.pm2_env?.restart_time || 0,
      cpu: Math.round(process?.monit?.cpu || 0),
      memory: Math.round((process?.monit?.memory || 0) / 1024 / 1024),
    }
  })
}

export async function controlWorker(worker: WorkerRecord, action: 'start' | 'stop' | 'restart') {
  validatePm2Name(worker.pm2_name)
  if (action !== 'stop') await validateWorkingDirectory(worker.working_directory)

  const { rows: projects } = await query<{ runtime_versions: Record<string, string> }>(
    'select runtime_versions from projects where lower(root_path)=lower($1) order by environment asc limit 1',
    [worker.working_directory]
  )
  const env = {
    ...(projects[0] ? projectRuntimeEnvironment(projects[0].runtime_versions) : {}),
    MANAGER_WORKER_CMD: worker.command,
    MANAGER_WORKER_CWD: worker.working_directory,
  }
  const described = await runCommand(`pm2 describe "${worker.pm2_name}"`)
  let result

  if (action === 'stop') {
    if (described.code !== 0) return { code: 0, output: 'Worker has not been started.' }
    result = await runCommand(`pm2 stop "${worker.pm2_name}"`)
  } else if (described.code !== 0) {
    result = await runCommand(
      `pm2 start "${WORKER_RUNNER}" --interpreter node --name "${worker.pm2_name}"`,
      worker.working_directory,
      undefined,
      undefined,
      env,
    )
  } else {
    result = await runCommand(
      `pm2 restart "${worker.pm2_name}" --update-env`,
      worker.working_directory,
      undefined,
      undefined,
      env,
    )
  }

  if (result.code !== 0) throw new Error(result.output || `PM2 ${action} failed`)
  await runCommand('pm2 save')
  return result
}

export async function deleteWorkerProcess(pm2Name: string) {
  validatePm2Name(pm2Name)
  const described = await runCommand(`pm2 describe "${pm2Name}"`)
  if (described.code === 0) {
    const result = await runCommand(`pm2 delete "${pm2Name}"`)
    if (result.code !== 0) throw new Error(result.output || 'PM2 delete failed')
    await runCommand('pm2 save')
  }
}
