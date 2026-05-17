import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { getSetting } from '@/lib/settings'
import { existsSync } from 'fs'
import { cp, rm } from 'fs/promises'
import path from 'path'
import { getProjectTypeDefaults, normalizeProjectType, type ProjectType } from '@/lib/project-types'

export interface DeployProject {
  id: string
  name: string
  repo_url: string
  default_branch: string
  root_path: string
  install_cmd: string | null
  build_cmd: string | null
  start_cmd: string | null
  project_type?: ProjectType | null
  pm2_name: string
  port: number | null
}

export interface DeployOptions {
  userId?: string | null
  trigger: 'manual' | 'webhook' | 'promote'
  commitSha?: string
  /** When promoting, the staging branch to merge into the production branch */
  mergeBranch?: string
}

export interface DeployResult {
  deploymentId: string
  status: 'success' | 'failed' | 'skipped'
  log: string
  commitSha?: string | null
}

const GIT_NETWORK_TIMEOUT = 300_000 // 5 minutes
const MANAGER_ROOT = process.cwd()
const PM2_RUNNER = path.join(MANAGER_ROOT, 'scripts', 'pm2-runner.js')
const STATIC_SERVER = path.join(MANAGER_ROOT, 'scripts', 'static-server.js')

function getInstallCommand(project: DeployProject) {
  return project.install_cmd ?? getProjectTypeDefaults(project.project_type).installCmd
}

function getBuildCommand(project: DeployProject) {
  return project.build_cmd ?? getProjectTypeDefaults(project.project_type).buildCmd
}

function getStartCommand(project: DeployProject) {
  return project.start_cmd ?? getProjectTypeDefaults(project.project_type).startCmd
}

function getPm2StartCommand(project: DeployProject, rootPath: string) {
  const projectType = normalizeProjectType(project.project_type)
  const portArg = project.port ? ` -p ${project.port}` : ''

  if (projectType === 'next' && !project.start_cmd) {
    const nextBin = path.join(rootPath, 'node_modules', 'next', 'dist', 'bin', 'next')
    return `pm2 start "${nextBin}" --interpreter node --name "${project.pm2_name}" -- start${portArg}`
  }

  if (projectType === 'angular' && !project.start_cmd) {
    return `pm2 start "${STATIC_SERVER}" --interpreter node --name "${project.pm2_name}"`
  }

  const startCmd = getStartCommand(project)
  if (!startCmd) {
    throw new Error(`No start command configured for ${project.pm2_name}`)
  }

  return `pm2 start "${PM2_RUNNER}" --interpreter node --name "${project.pm2_name}"`
}

function getRuntimeEnv(project: DeployProject, rootPath: string): Record<string, string> {
  const startCmd = getStartCommand(project)
  return {
    HOSTNAME: normalizeProjectType(project.project_type) === 'angular' ? '127.0.0.1' : '0.0.0.0',
    MANAGER_APP_CWD: rootPath,
    MANAGER_PORT: project.port ? project.port.toString() : '',
    ...(startCmd ? { MANAGER_START_CMD: project.port && normalizeProjectType(project.project_type) === 'laravel'
      ? `${startCmd} --port=${project.port}`
      : startCmd } : {}),
    ...(project.port ? { PORT: project.port.toString() } : {}),
  }
}

async function cleanGitLock(rootPath: string, append: (chunk: string) => void) {
  const lockFile = path.join(rootPath, '.git', 'index.lock')
  if (existsSync(lockFile)) {
    try {
      await rm(lockFile, { force: true })
      append(`[git] Removed stale index.lock file\n`)
    } catch (e) {
      append(`[git] Failed to remove index.lock: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
}

async function runGitCommandWithRetry(
  run: (cmd: string, cwd?: string, timeout?: number) => Promise<{ code: number, output: string }>,
  cmd: string,
  rootPath: string,
  append: (chunk: string) => void,
  retries = 2
): Promise<{ code: number, output: string }> {
  for (let i = 0; i <= retries; i++) {
    const res = await run(cmd, rootPath, GIT_NETWORK_TIMEOUT)
    if (res.code === 0) return res

    // Don't retry auth errors
    if (res.output.includes('Authentication failed') || res.output.includes('Cannot prompt')) {
      return res
    }

    if (i < retries) {
      append(`[retry] Command failed, retrying in 2s...\n`)
      await new Promise(r => setTimeout(r, 2000))
      // Clean lock before retry just in case
      await cleanGitLock(rootPath, append)
    }
  }
  return { code: 1, output: 'Max retries reached' } // Should return last result ideally, but this loop structure returns last result if code != 0
}

async function withGithubToken(repoUrl: string) {
  const token = await getSetting('GITHUB_TOKEN')
  if (!token) return repoUrl
  if (repoUrl.startsWith('https://github.com/')) {
    // Use token directly as username (works for both classic and fine-grained tokens)
    return repoUrl.replace('https://', `https://${token}@`)
  }
  return repoUrl
}

async function requireGithubToken(repoUrl: string) {
  if (repoUrl.startsWith('https://')) {
    const token = await getSetting('GITHUB_TOKEN')
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set. Go to Settings and add your GitHub token before deploying.')
    }
  }
}

/** Check if a deploy is already running for this project */
async function isDeployRunning(projectId: string): Promise<boolean> {
  const TIMEOUT_MINUTES = 30

  // Find all running deployments for this project
  const { rows } = await query<{ id: string; started_at: string }>(
    `SELECT id, started_at FROM deployments WHERE project_id = $1 AND status = 'running'`,
    [projectId]
  )

  if (rows.length === 0) return false

  // Check if any running deployments are stale (older than TIMEOUT_MINUTES)
  const now = new Date()
  const staleDeployments = rows.filter(row => {
    if (!row.started_at) return false
    const startedAt = new Date(row.started_at)
    const elapsedMinutes = (now.getTime() - startedAt.getTime()) / (1000 * 60)
    return elapsedMinutes > TIMEOUT_MINUTES
  })

  // Auto-fail stale deployments
  for (const stale of staleDeployments) {
    const startedAt = new Date(stale.started_at)
    const elapsedMinutes = Math.floor((now.getTime() - startedAt.getTime()) / (1000 * 60))
    const log = `[timeout] Deployment exceeded ${TIMEOUT_MINUTES} minute timeout (ran for ${elapsedMinutes} minutes). Auto-failed to allow new deployments.`

    await query(
      `UPDATE deployments SET status = 'failed', finished_at = now(), log = COALESCE(log || $1, $1) WHERE id = $2`,
      ['\n' + log, stale.id]
    )
  }

  // Return true only if there are still active (non-stale) deployments
  return rows.length > staleDeployments.length
}

/** Health check: HTTP GET to localhost:port with retries */
async function healthCheck(port: number, retries = 3, delayMs = 5000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok || res.status === 404 || res.status === 302) return true
    } catch {
      // retry
    }
    if (i < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  return false
}

export async function runDeploy(project: DeployProject, options: DeployOptions): Promise<DeployResult> {
  // Concurrency guard
  if (await isDeployRunning(project.id)) {
    return { deploymentId: '', status: 'skipped', log: 'Deploy already running for this project' }
  }

  const { rows: deploymentRows } = await query<{ id: string }>(
    `INSERT INTO deployments (project_id, user_id, status, trigger, started_at)
     VALUES ($1, $2, 'running', $3, now()) RETURNING id`,
    [project.id, options.userId || null, options.trigger]
  )
  const deploymentId = deploymentRows[0].id
  let log = ''

  const append = (chunk: string) => { log += chunk }
  const flush = async () => {
    await query(`UPDATE deployments SET log = $1 WHERE id = $2`, [log, deploymentId])
  }

  await requireGithubToken(project.repo_url)
  const repoUrl = await withGithubToken(project.repo_url)
  const rootPath = project.root_path
  const branch = project.default_branch || 'main'
  const nextDir = path.join(rootPath, '.next')
  const backupDir = path.join(rootPath, '.next.backup')

  try {
    // Step 1: Git fetch + reset (or checkout specific commit for promotions)
    const isGitRepo = existsSync(path.join(rootPath, '.git'))
    if (!existsSync(rootPath) || !isGitRepo) {
      append(`[clone] ${project.repo_url} -> ${rootPath}\n`)
      const cloneResult = await runCommand(`git clone --branch ${branch} ${repoUrl} "${rootPath}"`, undefined, GIT_NETWORK_TIMEOUT)
      append(cloneResult.output)
      if (cloneResult.code !== 0) throw new Error('Clone failed')

      if (options.commitSha) {
        append(`[checkout] Promoting commit ${options.commitSha.slice(0, 7)}\n`)
        const checkout = await runCommand(`git checkout ${options.commitSha}`, rootPath)
        append(checkout.output)
        if (checkout.code !== 0) throw new Error('Checkout of promoted commit failed')
      }
    } else {
      if (options.commitSha) {
        // Promote: fetch just the commit we need, then checkout
        append(`[fetch] git fetch ${branch}\n`)
        const fetch = await runCommand(`git fetch ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)
        append(fetch.output)
        if (fetch.code !== 0) throw new Error('Fetch failed')

        append(`[promote] Deploying verified commit ${options.commitSha.slice(0, 7)}\n`)
        const checkout = await runCommand(`git checkout ${options.commitSha}`, rootPath)
        append(checkout.output)
        if (checkout.code !== 0) throw new Error('Checkout of promoted commit failed')
      } else {
        // Ensure we're on the correct branch, then pull
        append(`[checkout] git checkout ${branch}\n`)
        const checkout = await runCommand(`git checkout ${branch}`, rootPath)
        append(checkout.output)
        if (checkout.code !== 0) throw new Error('Checkout failed')

        append(`[pull] git pull ${branch}\n`)
        const pull = await runCommand(`git pull ${repoUrl} ${branch} --ff-only`, rootPath, GIT_NETWORK_TIMEOUT)
        append(pull.output)
        if (pull.code !== 0) {
          // If fast-forward fails (local diverged), force reset
          append(`[reset] Fast-forward failed, resetting to FETCH_HEAD\n`)
          await runCommand(`git fetch ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)
          const reset = await runCommand(`git reset --hard FETCH_HEAD`, rootPath)
          append(reset.output)
          if (reset.code !== 0) throw new Error('Reset failed')
        }
      }
    }
    await flush()

    // Step 2: install dependencies
    const installCmd = getInstallCommand(project)
    if (installCmd) {
      append(`[install] ${installCmd}\n`)
      const install = await runCommand(installCmd, rootPath)
      append(install.output)
      if (install.code !== 0) throw new Error('Install failed')
    }
    await flush()

    // Step 3: Backup .next
    if (existsSync(nextDir)) {
      append('[backup] Backing up .next -> .next.backup\n')
      if (existsSync(backupDir)) {
        await rm(backupDir, { recursive: true, force: true })
      }
      await cp(nextDir, backupDir, { recursive: true })
    }

    // Step 4: Build
    const buildCmd = getBuildCommand(project)
    if (buildCmd) {
      append(`[build] ${buildCmd}\n`)
      const build = await runCommand(buildCmd, rootPath)
      append(build.output)
      if (build.code !== 0) {
        // Build failed — restore backup
        append('[rollback] Build failed, restoring .next.backup\n')
        if (existsSync(backupDir)) {
          if (existsSync(nextDir)) await rm(nextDir, { recursive: true, force: true })
          await cp(backupDir, nextDir, { recursive: true })
          await rm(backupDir, { recursive: true, force: true })
        }
        throw new Error('Build failed')
      }
    }
    await flush()

    // Step 5: PM2 restart (or start if first deploy)
    const pm2Check = await runCommand(`pm2 describe "${project.pm2_name}"`)
    const syncEnv = getRuntimeEnv(project, rootPath)
    if (pm2Check.code !== 0) {
      append(`[pm2] Starting ${project.pm2_name} (first deploy)\n`)
      const start = await runCommand(
        getPm2StartCommand(project, rootPath),
        rootPath,
        undefined,
        undefined,
        syncEnv
      )
      append(start.output)
      if (start.code !== 0) throw new Error('PM2 start failed')
    } else {
      append(`[pm2] Restarting ${project.pm2_name}\n`)
      const restart = await runCommand(`pm2 restart "${project.pm2_name}" --update-env`, rootPath, undefined, undefined, syncEnv)
      append(restart.output)
      if (restart.code !== 0) throw new Error('PM2 restart failed')
    }
    await flush()

    // Step 6: Health check
    if (project.port) {
      append(`[health] Checking http://127.0.0.1:${project.port} ...\n`)
      // Wait a moment for the app to start
      await new Promise(resolve => setTimeout(resolve, 3000))
      const healthy = await healthCheck(project.port)
      if (!healthy) {
        append('[rollback] Health check failed, restoring .next.backup\n')
        if (existsSync(backupDir)) {
          // Stop PM2 first to release file locks on .next directory (Windows EBUSY fix)
          await runCommand(`pm2 stop "${project.pm2_name}"`)
          if (existsSync(nextDir)) await rm(nextDir, { recursive: true, force: true })
          await cp(backupDir, nextDir, { recursive: true })
          await rm(backupDir, { recursive: true, force: true })
          append('[pm2] Restarting with restored build\n')
          await runCommand(`pm2 restart "${project.pm2_name}" --update-env`, rootPath, undefined, undefined, syncEnv)
        }
        throw new Error('Health check failed after deploy')
      }
      append('[health] OK\n')
    }
    await flush()

    // Step 7: pm2 save
    await runCommand('pm2 save')
    append('[pm2] State saved\n')

    // Step 8: Get commit SHA
    const shaResult = await runCommand('git rev-parse HEAD', rootPath)
    const commitSha = shaResult.output.trim() || null

    // Step 9: Cleanup backup
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true })
    }

    // Step 10: Update deployment record
    await query(
      `UPDATE deployments SET status = 'success', finished_at = now(), log = $1, commit_sha = $2, branch = $3 WHERE id = $4`,
      [log, commitSha, branch, deploymentId]
    )

    return { deploymentId, status: 'success', log, commitSha }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment failed'
    append(`\n[error] ${message}\n`)
    await query(
      `UPDATE deployments SET status = 'failed', finished_at = now(), log = $1 WHERE id = $2`,
      [log, deploymentId]
    )
    return { deploymentId, status: 'failed', log }
  }
}

/**
 * Start a deploy asynchronously — returns the deploymentId immediately so the
 * caller can begin streaming logs. The actual deploy runs in the background.
 */
export async function startDeploy(
  project: DeployProject,
  options: DeployOptions
): Promise<string | null> {
  if (await isDeployRunning(project.id)) {
    return null
  }

  // Create deployment record up-front
  const { rows } = await query<{ id: string }>(
    `INSERT INTO deployments (project_id, user_id, status, trigger, started_at)
     VALUES ($1, $2, 'running', $3, now()) RETURNING id`,
    [project.id, options.userId || null, options.trigger]
  )
  const deploymentId = rows[0].id

  // Fire off the deploy without awaiting — logs will be flushed incrementally
  void runDeployAsync(project, options, deploymentId)

  return deploymentId
}

/** Internal: run the deploy steps for an already-created deployment record */
async function runDeployAsync(
  project: DeployProject,
  options: DeployOptions,
  deploymentId: string
) {
  let log = '[system] Starting deployment...\n'

  try {
    await query(`UPDATE deployments SET log = $1 WHERE id = $2`, [log, deploymentId])
  } catch (err) {
    console.error('[Manager] Failed to write initial log:', err)
  }

  // Serialized logging helper to prevent connection pool exhaustion
  // Only one DB update runs at a time; others queue up by updating the 'log' variable
  let isUpdating = false

  const append = async (chunk: string) => {
    log += chunk

    if (isUpdating) return
    isUpdating = true

    try {
      // Keep writing until the DB matches the in-memory log
      // This handles high-throughput logs without spawning 100s of queries
      while (true) {
        const currentLog = log
        await query(`UPDATE deployments SET log = $1 WHERE id = $2`, [currentLog, deploymentId])
        if (log === currentLog) break
      }
    } catch (err) {
      console.error('[Manager] DB Log Update Failed:', err)
    } finally {
      isUpdating = false
    }
  }

  // Wrapper for runCommand to auto-append logs
  const run = async (cmd: string, cwd?: string, timeout?: number, env?: Record<string, string>) => {
    return runCommand(cmd, cwd, timeout, (data) => void append(data), env)
  }

  try {
    await requireGithubToken(project.repo_url)
    const repoUrl = await withGithubToken(project.repo_url)
    const rootPath = project.root_path
    const branch = project.default_branch || 'main'
    const nextDir = path.join(rootPath, '.next')
    const backupDir = path.join(rootPath, '.next.backup')

    // Step 1: Git
    const isGitRepo = existsSync(path.join(rootPath, '.git'))
    if (!existsSync(rootPath) || !isGitRepo) {
      await append(`[clone] ${project.repo_url} -> ${rootPath}\n`)
      const cloneResult = await run(`git clone --branch ${branch} ${repoUrl} "${rootPath}"`, undefined, GIT_NETWORK_TIMEOUT)
      if (cloneResult.code !== 0) {
        if (cloneResult.output.includes('Cannot prompt') || cloneResult.output.includes('Authentication failed')) {
          throw new Error('Authentication failed. Please check your GITHUB_TOKEN in Settings.')
        }
        throw new Error('Clone failed')
      }

      if (options.mergeBranch) {
        // Fresh clone for promotion: fetch staging branch and merge
        const stagingBranch = options.mergeBranch
        await append(`[fetch] Fetching ${stagingBranch}...\n`)
        const fetchStaging = await run(
          `git fetch ${repoUrl} +refs/heads/${stagingBranch}:refs/remotes/origin/${stagingBranch}`,
          rootPath, GIT_NETWORK_TIMEOUT
        )
        if (fetchStaging.code !== 0) throw new Error(`Failed to fetch ${stagingBranch}`)

        await append(`[promote] Merging ${stagingBranch} into ${branch}...\n`)
        const merge = await run(
          `git merge origin/${stagingBranch} --no-edit -m "Promote ${stagingBranch} to ${branch}"`,
          rootPath
        )
        if (merge.code !== 0) {
          await run(`git merge --abort`, rootPath)
          throw new Error(`Merge conflict: ${stagingBranch} could not be merged into ${branch}. Resolve conflicts manually.`)
        }

        await append(`[push] Pushing merged ${branch} to remote...\n`)
        const push = await run(`git push ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)
        if (push.code !== 0) throw new Error(`Failed to push merged ${branch} to remote`)
      } else if (options.commitSha) {
        await append(`[checkout] Promoting commit ${options.commitSha.slice(0, 7)}\n`)
        const checkout = await run(`git checkout ${options.commitSha}`, rootPath)
        if (checkout.code !== 0) throw new Error('Checkout of promoted commit failed')
      }
    } else if (options.mergeBranch) {
      // Promotion: merge staging branch into production branch
      const stagingBranch = options.mergeBranch
      await cleanGitLock(rootPath, (c) => void append(c))

      // Fetch both branches from remote (use explicit refspecs to update origin/* tracking refs)
      await append(`[fetch] Fetching ${branch} and ${stagingBranch}...\n`)
      const refspecs = `+refs/heads/${branch}:refs/remotes/origin/${branch} +refs/heads/${stagingBranch}:refs/remotes/origin/${stagingBranch}`
      let fetchResult = await run(`git fetch ${repoUrl} ${refspecs}`, rootPath, GIT_NETWORK_TIMEOUT)
      if (fetchResult.code !== 0) {
        await append(`[retry] Fetch failed, retrying...\n`)
        await cleanGitLock(rootPath, (c) => void append(c))
        fetchResult = await run(`git fetch ${repoUrl} ${refspecs}`, rootPath, GIT_NETWORK_TIMEOUT)
      }
      if (fetchResult.code !== 0) {
        if (fetchResult.output.includes('Cannot prompt') || fetchResult.output.includes('Authentication failed')) {
          throw new Error('Authentication failed. Please check your GITHUB_TOKEN in Settings.')
        }
        throw new Error('Fetch failed')
      }

      // Checkout production branch
      await append(`[checkout] git checkout ${branch}\n`)
      const checkout = await run(`git checkout ${branch}`, rootPath)
      if (checkout.code !== 0) throw new Error(`Checkout ${branch} failed`)

      // Reset production branch to match remote
      await append(`[reset] git reset --hard origin/${branch}\n`)
      const reset = await run(`git reset --hard origin/${branch}`, rootPath)
      if (reset.code !== 0) throw new Error('Reset failed')

      // Merge staging branch into production branch
      await append(`[promote] Merging ${stagingBranch} into ${branch}...\n`)
      const merge = await run(
        `git merge origin/${stagingBranch} --no-edit -m "Promote ${stagingBranch} to ${branch}"`,
        rootPath
      )
      if (merge.code !== 0) {
        // Abort the merge if it failed (conflict)
        await run(`git merge --abort`, rootPath)
        throw new Error(`Merge conflict: ${stagingBranch} could not be merged into ${branch}. Resolve conflicts manually.`)
      }

      // Push the merged production branch back to remote
      await append(`[push] Pushing merged ${branch} to remote...\n`)
      const push = await run(`git push ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)
      if (push.code !== 0) throw new Error(`Failed to push merged ${branch} to remote`)
    } else {
      // Normal deploy: fetch + reset to latest
      await append(`[checkout] git checkout ${branch}\n`)
      const checkout = await run(`git checkout ${branch}`, rootPath)
      if (checkout.code !== 0) throw new Error('Checkout failed')

      // Pre-flight cleanup
      await cleanGitLock(rootPath, (c) => void append(c))

      await append(`[fetch] git fetch ${branch}\n`)
      let fetch = await run(`git fetch ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)

      // Retry logic for fetch
      if (fetch.code !== 0) {
        await append(`[retry] Fetch failed, retrying...\n`)
        await cleanGitLock(rootPath, (c) => void append(c))
        fetch = await run(`git fetch ${repoUrl} ${branch}`, rootPath, GIT_NETWORK_TIMEOUT)
      }

      if (fetch.code !== 0) {
        if (fetch.output.includes('Cannot prompt') || fetch.output.includes('Authentication failed')) {
          throw new Error('Authentication failed. Please check your GITHUB_TOKEN in Settings.')
        }
        throw new Error('Fetch failed')
      }

      await append(`[reset] git reset --hard FETCH_HEAD\n`)
      const reset = await run(`git reset --hard FETCH_HEAD`, rootPath)
      if (reset.code !== 0) throw new Error('Reset failed')
    }

    // Stop the process before install/build to prevent file locking issues on Windows
    // We do this after git operations but before npm install/build which might touch locked files
    const pm2CheckInitial = await run(`pm2 describe "${project.pm2_name}"`)
    const wasRunning = pm2CheckInitial.code === 0 && !pm2CheckInitial.output.includes('stopped')

    if (wasRunning) {
      await append(`[pm2] Stopping ${project.pm2_name} to release file locks...\n`)
      await run(`pm2 stop "${project.pm2_name}"`)
    }

    // Step 2: install dependencies
    const installCmd = getInstallCommand(project)
    if (installCmd) {
      await append(`[install] ${installCmd}\n`)
      // Force development environment to ensure devDependencies (like @tailwindcss/postcss) are installed
      const install = await run(installCmd, rootPath, undefined, { NODE_ENV: 'development' })
      if (install.code !== 0) throw new Error('Install failed')
    }

    // Step 3: Backup .next
    if (existsSync(nextDir)) {
      await append('[backup] Backing up .next -> .next.backup\n')
      if (existsSync(backupDir)) {
        await rm(backupDir, { recursive: true, force: true })
      }
      await cp(nextDir, backupDir, { recursive: true })
    }

    // Step 4: Build
    const buildCmd = getBuildCommand(project)
    if (buildCmd) {
      await append(`[build] ${buildCmd}\n`)
      const build = await run(buildCmd, rootPath)

      if (build.code !== 0) {
        await append('[rollback] Build failed, restoring .next.backup\n')
        if (existsSync(backupDir)) {
          if (existsSync(nextDir)) await rm(nextDir, { recursive: true, force: true })
          await cp(backupDir, nextDir, { recursive: true })
          await rm(backupDir, { recursive: true, force: true })
        }
        throw new Error('Build failed')
      }
    }

    // Step 5: PM2 restart (or start if first deploy)
    const pm2Check = await run(`pm2 describe "${project.pm2_name}"`)
    const env = getRuntimeEnv(project, rootPath)

    if (pm2Check.code !== 0) {
      await append(`[pm2] Starting ${project.pm2_name} (first deploy)\n`)
      const start = await run(
        getPm2StartCommand(project, rootPath),
        rootPath,
        undefined,
        env
      )
      if (start.code !== 0) throw new Error('PM2 start failed')

    } else {
      await append(`[pm2] Restarting ${project.pm2_name}\n`)
      // Use --update-env to ensure the new PORT env var is picked up
      // If it was stopped, restart will start it
      const restart = await run(`pm2 restart "${project.pm2_name}" --update-env`, rootPath, undefined, env)
      if (restart.code !== 0) throw new Error('PM2 restart failed')
    }

    // Step 6: Health check
    if (project.port) {
      await append(`[health] Checking http://127.0.0.1:${project.port} ...\n`)

      // Retry loop: check every 2 seconds, up to 30 times (60s total)
      let healthy = false
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000))
        if (await healthCheck(project.port)) {
          healthy = true
          break
        }
      }

      if (!healthy) {
        await append('[rollback] Health check failed after 60s, restoring .next.backup\n')
        if (existsSync(backupDir)) {
          // Stop PM2 first to release file locks on .next directory (Windows EBUSY fix)
          await append('[pm2] Stopping process to release file locks...\n')
          await run(`pm2 stop "${project.pm2_name}"`)
          if (existsSync(nextDir)) await rm(nextDir, { recursive: true, force: true })
          await cp(backupDir, nextDir, { recursive: true })
          await rm(backupDir, { recursive: true, force: true })
          await append('[pm2] Restarting with restored build\n')
          await run(`pm2 restart "${project.pm2_name}" --update-env`, rootPath, undefined, env)
        }
        throw new Error('Health check failed after deploy')
      }
      await append('[health] OK\n')
    }

    // Step 7: pm2 save
    await run('pm2 save')
    await append('[pm2] State saved\n')

    // Step 8: Get commit SHA
    const shaResult = await run('git rev-parse HEAD', rootPath)
    const commitSha = shaResult.output.trim() || null

    // Step 9: Cleanup backup
    if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true })
    }

    // Step 10: Update deployment record
    await query(
      `UPDATE deployments SET status = 'success', finished_at = now(), log = $1, commit_sha = $2, branch = $3 WHERE id = $4`,
      [log, commitSha, branch, deploymentId]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment failed'
    await append(`\n[error] ${message}\n`)

    // Attempt to restart the service if it was stopped and we failed
    try {
      const pm2Check = await run(`pm2 describe "${project.pm2_name}"`)
      // If it exists but is stopped (or we just want to be sure it's up), try to restart
      if (pm2Check.code === 0) {
        await append(`[pm2] Attempting to restart service after failure...\n`)
        await run(`pm2 restart "${project.pm2_name}"`)
      }
    } catch (e) {
      console.error('Failed to restart service during rollback:', e)
    }

    // Ensure status is updated to failed even if the error happened during setup
    await query(
      `UPDATE deployments SET status = 'failed', finished_at = now(), log = $1 WHERE id = $2`,
      [log, deploymentId]
    )
  }
}
