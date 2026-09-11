import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { getGitHubConnectionToken } from '@/lib/github-connections'
import { existsSync, readFileSync } from 'fs'
import { rm, writeFile } from 'fs/promises'
import path from 'path'
import { DeploymentRelease, sourceFingerprint } from '@/lib/deployment-release'
import { withInstallationSlot } from '@/lib/deployment-capacity'
import { installWithDependencyCache, assertAuditPassed, formatAuditFindings } from '@/lib/deployment-cache'
import { ensureDeploymentSchema } from '@/lib/deployment-schema'
import { beginReleaseActivation } from '@/lib/deployment-activation'
import { captureProjectProcesses, stopProjectProcesses } from '@/lib/deployment-processes'
import { recoverProjectTerminalLocks } from '@/lib/deployment-terminals'
import { logProjectDirectoryHandles } from '@/lib/deployment-locks'
import { managedStartCommand, managedRuntimeEnvironment } from '@/lib/deployment-runtime'
import { parse as parseDotenv } from 'dotenv'
import { getProjectTypeDefaults, getProjectPortEnvironment, normalizeProjectType, type ProjectType } from '@/lib/project-types'
import { notifyDeploy, sendNotification } from '@/lib/notify'
import { getProjectDatabaseEnv } from '@/lib/project-databases'
import { getProjectDataServiceEnv } from '@/lib/data-services'
import { projectRuntimeEnvironment } from '@/lib/runtimes'
import { waitForDeploymentHealth } from '@/lib/deployment-health'
import { runDeploymentCommand } from '@/lib/deployment-command'
import { detectGoBuildCommand } from '@/lib/deployment-go'
import { assertCleanDeploymentCheckout, syncDeploymentCheckout } from '@/lib/deployment-git'
import { defaultInstallCommand, detectCheckoutProjectType, prepareProjectCheckout, prepareProjectParent, resolveCheckoutCommands, runPreparedDeploymentCommand, localNpmInstall } from '@/lib/deployment-preparation'
import { allocateTemporaryPort } from '@/lib/ports'
import { updateCaddyDomainsStrict } from '@/lib/caddy'

/**
 * Read the target project's own .env / .env.local directly and pass the
 * values explicitly to install/pre-deploy/build child processes, instead of
 * relying on the nested `next build` (or migration) process to load them
 * itself. Deploys run in-process inside the manager's own long-lived Next.js
 * server, and builds spawned that way have intermittently failed to see
 * vars like DATABASE_URL that a manually-run build in the same directory
 * picks up fine — root cause not pinned down, so this sidesteps it rather
 * than depending on env-file auto-loading working inside a nested spawn.
 * For frontend/Node projects, .env.local wins over .env for shared keys,
 * matching Next's precedence. Laravel intentionally reads only .env so an
 * unrelated .env.local file cannot override its production configuration.
 */
function loadProjectEnvFile(rootPath: string, projectType?: ProjectType | null): Record<string, string> {
  const merged: Record<string, string> = {}
  const filenames = normalizeProjectType(projectType) === 'laravel' ? ['.env'] : ['.env', '.env.local']
  for (const filename of filenames) {
    const filePath = path.join(rootPath, filename)
    if (!existsSync(filePath)) continue
    try {
      Object.assign(merged, parseDotenv(readFileSync(filePath)))
    } catch {
      // Ignore unreadable/malformed env files — build will surface its own error if a var is missing
    }
  }
  return merged
}

export interface DeployProject {
  id: string
  name: string
  repo_url: string
  default_branch: string
  root_path: string
  install_cmd: string | null
  build_cmd: string | null
  deploy_script?: string | null
  start_cmd: string | null
  pre_deploy_cmd?: string | null
  post_deploy_cmd?: string | null
  project_type?: ProjectType | null
  pm2_name: string
  port: number | null
  github_connection_id?: string | null
  runtime_versions?: Record<string, string> | null
}

export interface DeployOptions {
  userId?: string | null
  trigger: 'manual' | 'webhook' | 'promote' | 'rollback'
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

// Cancellation flags shared across route bundles (deployments run in-process)
const cancelledDeployments: Set<string> =
  ((globalThis as unknown as { __cancelledDeployments?: Set<string> }).__cancelledDeployments ??= new Set())
const activeDeployments: Set<string> =
  ((globalThis as unknown as { __activeDeployments?: Set<string> }).__activeDeployments ??= new Set())

/** Installation, build and script commands stop their process tree when cancelled. */
export function requestDeployCancel(deploymentId: string) {
  cancelledDeployments.add(deploymentId)
}

function throwIfCancelled(deploymentId: string) {
  if (cancelledDeployments.has(deploymentId)) {
    throw new Error('Deployment cancelled by user')
  }
}
const MANAGER_ROOT = process.cwd()
const PM2_RUNNER = path.join(MANAGER_ROOT, 'scripts', 'pm2-runner.js')
const STATIC_SERVER = path.join(MANAGER_ROOT, 'scripts', 'static-server.js')
const CONTROL_PLANE_ENV_KEYS = [
  'JWT_SECRET',
  'MANAGER_ENCRYPTION_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
]

async function getInstallCommand(project: DeployProject) {
  return project.install_cmd ?? await defaultInstallCommand(project.root_path, project.project_type)
}

async function prepareDeploymentProject(project: DeployProject, append: (chunk: string) => void | Promise<void>) {
  const detected = await detectCheckoutProjectType(project.root_path)
  const commands = resolveCheckoutCommands(project, detected)
  await prepareProjectCheckout(project.root_path, commands.project_type, append)
  if (commands !== project) {
    // Do not overwrite command settings edited while checkout was running.
    const updated = await query(
      `UPDATE projects SET project_type = $1, install_cmd = $2, build_cmd = $3, start_cmd = $4
       WHERE id = $5 AND project_type IS NOT DISTINCT FROM $6
       AND install_cmd IS NOT DISTINCT FROM $7 AND build_cmd IS NOT DISTINCT FROM $8
       AND start_cmd IS NOT DISTINCT FROM $9 RETURNING id`,
      [commands.project_type, commands.install_cmd, commands.build_cmd, commands.start_cmd, project.id,
        project.project_type ?? null, project.install_cmd, project.build_cmd, project.start_cmd]
    )
    if (!updated.rowCount) throw new Error('Project settings changed during checkout; retry deployment with the current settings')
    Object.assign(project, commands)
    await append(`[prepare] Detected ${detected}; corrected the default Next.js registration. Deployment script and assigned port are unchanged\n`)
  }
}

async function getBuildCommand(project: DeployProject, execute: (command: string) => Promise<{ code: number; output: string }>, append: (chunk: string) => void | Promise<void>) {
  if (!project.build_cmd && normalizeProjectType(project.project_type) === 'go') {
    return detectGoBuildCommand(project.root_path, execute, append)
  }
  return project.build_cmd ?? getProjectTypeDefaults(project.project_type).buildCmd
}

async function executeDeploymentScript(
  script: string,
  branch: string,
  execute: (command: string) => Promise<{ code: number; output: string }>,
  append: (chunk: string) => void | Promise<void>
) {
  const lines = script.replace(/\r\n/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index++) {
    const source = lines[index].trim()
    if (!source || source.startsWith('#')) continue

    // Manager runs on Windows, where cmd.exe expands %BRANCH% instead of $BRANCH.
    const command = process.platform === 'win32'
      ? source.replace(/\$\{BRANCH\}|\$BRANCH\b/g, '%BRANCH%')
      : source

    await append(`[script:${index + 1}] ${source}\n`)
    const result = await execute(command)
    if (result.code !== 0) {
      throw new Error(`Deployment script failed at line ${index + 1}`)
    }
  }
}

function getStartCommand(project: DeployProject) {
  return project.start_cmd ?? getProjectTypeDefaults(project.project_type).startCmd
}

function getPm2StartCommand(project: DeployProject, rootPath: string) {
  const projectType = normalizeProjectType(project.project_type)
  const portArg = project.port ? ` -p ${project.port}` : ''

  if (projectType === 'next' && !project.start_cmd && !project.runtime_versions?.node) {
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

  return `pm2 start "${PM2_RUNNER}" --interpreter node --name "${project.pm2_name}" --shutdown-with-message --kill-timeout 15000`
}

function getRuntimeEnv(project: DeployProject, rootPath: string, databaseEnv: Record<string, string> = {}): Record<string, string> {
  const startCmd = getStartCommand(project)
  return {
    ...Object.fromEntries(CONTROL_PLANE_ENV_KEYS.map((key) => [key, ''])),
    ...loadProjectEnvFile(rootPath, project.project_type),
    ...databaseEnv,
    ...projectRuntimeEnvironment(project.runtime_versions),
    HOSTNAME: normalizeProjectType(project.project_type) === 'angular' ? '127.0.0.1' : '0.0.0.0',
    MANAGER_APP_CWD: rootPath,
    MANAGER_PORT: project.port ? project.port.toString() : '',
    ...(startCmd ? { MANAGER_START_CMD: managedStartCommand(startCmd, normalizeProjectType(project.project_type), project.port) } : {}),
    ...managedRuntimeEnvironment(normalizeProjectType(project.project_type)),
    ...getProjectPortEnvironment(project.project_type, project.port),
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

async function withGithubToken(project: DeployProject) {
  const token = await getGitHubConnectionToken(project.github_connection_id)
  if (!token) return project.repo_url
  if (project.repo_url.startsWith('https://github.com/')) {
    // Use token directly as username (works for both classic and fine-grained tokens)
    return project.repo_url.replace('https://', `https://${token}@`)
  }
  return project.repo_url
}

async function requireGithubToken(project: DeployProject) {
  if (project.repo_url.startsWith('https://')) {
    const token = await getGitHubConnectionToken(project.github_connection_id)
    if (!token) {
      throw new Error('Assign a GitHub connection to this project before deploying.')
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
    if (activeDeployments.has(row.id)) return false
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

async function getPm2ProcessStatus(name: string, timeoutMs: number): Promise<string | undefined> {
  // Never stream jlist output: it includes every managed application's environment.
  const result = await runCommand('pm2 jlist', undefined, timeoutMs)
  if (result.code !== 0) return undefined
  try {
    const processes = JSON.parse(result.output) as Array<{ name: string; pm2_env?: { status?: string } }>
    const process = processes.find(item => item.name === name)
    return process ? process.pm2_env?.status : 'missing'
  } catch {
    return undefined
  }
}


async function createDeployment(project: DeployProject, options: DeployOptions) {
  await ensureDeploymentSchema()
  if (await isDeployRunning(project.id)) return null
  const { assertProjectSetupComplete } = await import('@/lib/project-setup')
  await assertProjectSetupComplete(project.id)
  const { acquireProjectOperation } = await import('@/lib/project-operation')
  const release = await acquireProjectOperation(project.id)
  try {
    const { rows } = await query<{ id: string }>(
      "INSERT INTO deployments (project_id,user_id,status,trigger,started_at,phase,branch) VALUES ($1,$2,'running',$3,now(),'prepare',$4) RETURNING id",
      [project.id, options.userId || null, options.trigger, project.default_branch || 'main'])
    return rows[0].id
  } finally { await release() }
}

export async function runDeploy(project: DeployProject, options: DeployOptions): Promise<DeployResult> {
  const id = await createDeployment(project, options)
  return id ? runDeployAsync(project, options, id) : { deploymentId: '', status: 'skipped', log: 'Deploy already running for this project' }
}

export async function startDeploy(project: DeployProject, options: DeployOptions): Promise<string | null> {
  const id = await createDeployment(project, options)
  if (id) void runDeployAsync(project, options, id).catch(error => console.error('[Manager] Deployment finalization failed:', error))
  return id
}

async function runDeployAsync(project: DeployProject, options: DeployOptions, deploymentId: string): Promise<DeployResult> {
  activeDeployments.add(deploymentId)
  const started = Date.now()
  let log = '[system] Starting isolated deployment; current release stays online during build\n'
  let flushing: Promise<void> | undefined
  let activating = false
  let accepted = false
  let recoverable = true
  let previousStatus: string | undefined
  let previousProcessFile: string | undefined
  const pausedWorkers: string[] = []
  let previewName: string | undefined
  let previewRunning = false
  let previewPort: number | undefined
  let caddyOnPreview = false
  let projectDomains: string[] = []
  const release = new DeploymentRelease(project.root_path, project.id, deploymentId)
  const branch = project.default_branch || 'main'
  const root = release.candidate
  const check = () => throwIfCancelled(deploymentId)
  const redact = (value: string) => value.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
  const flush = (): Promise<void> => flushing ??= (async () => {
    while (true) {
      const current = log
      await query('UPDATE deployments SET log=$1 WHERE id=$2', [current, deploymentId])
      if (current === log) break
    }
  })().finally(() => { flushing = undefined })
  const append = async (chunk: string) => { log += redact(chunk); await flush() }
  let lastStage = { phase: 'prepare', startedAt: Date.now() }
  const stage = async (phase: string) => {
    check()
    await append(`[timing] ${lastStage.phase}: ${Math.round((Date.now() - lastStage.startedAt) / 1000)}s\n`)
    lastStage = { phase, startedAt: Date.now() }
    await query('UPDATE deployments SET phase=$1 WHERE id=$2', [phase, deploymentId])
    await append('[stage] ' + phase + '\n')
  }
  const git = async (command: string, cwd = root) => {
    check()
    const result = await runCommand(command, cwd, GIT_NETWORK_TIMEOUT, undefined, undefined, false)
    check()
    return result
  }
  const loggedGit = async (command: string, cwd = root) => {
    const result = await git(command, cwd)
    await append(result.output)
    if (result.code !== 0) throw new Error('Git command failed; candidate retained and current source unchanged')
    return result
  }
  const pm2 = async (command: string, cwd = project.root_path, env?: Record<string, string>) => {
    const result = await runCommand(command, cwd, 60_000, undefined, env, false)
    await append(result.output)
    if (result.code) throw new Error('PM2 operation failed')
    return result
  }
  const stopService = async (name: string, action: 'stop' | 'delete', laravel = false, serviceRoot = project.root_path) => {
    const snapshot = await runCommand('pm2 jlist', undefined, 15_000)
    if (snapshot.code) throw new Error('Cannot inspect project processes before stopping the service')
    const services = (JSON.parse(snapshot.output) as Array<{ name: string; pid: number; pm2_env: { pm_cwd: string } }>).filter(item => item.name === name)
    for (const service of services) {
      if (!service.pm2_env.pm_cwd || path.resolve(service.pm2_env.pm_cwd).toLowerCase() !== path.resolve(serviceRoot).toLowerCase()) {
        throw new Error('PM2 service directory does not match the application; refusing to stop it')
      }
    }
    const processes = await captureProjectProcesses(serviceRoot, services.map(item => item.pid).filter(pid => pid > 0), laravel)
    // Run outside the application directory so the stop command cannot hold a directory being renamed.
    if (services.length) await pm2(`pm2 ${action} "${name}"`, path.dirname(serviceRoot))
    await stopProjectProcesses(processes, append)
  }
  try {
    await flush()
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) throw new Error('Invalid deployment branch')
    if (options.commitSha && !/^[a-fA-F0-9]{7,40}$/.test(options.commitSha)) throw new Error('Invalid deployment commit')
    if (options.mergeBranch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.mergeBranch) || options.mergeBranch.includes('..'))) throw new Error('Invalid promotion branch')
    if (!/^[A-Za-z0-9._-]+$/.test(project.pm2_name)) throw new Error('Invalid PM2 application name')
    if (path.resolve(project.root_path).toLowerCase() === path.resolve(MANAGER_ROOT).toLowerCase()) {
      throw new Error('Manager must be upgraded with its verified release installer, not its own application deployer')
    }
    const commands = [project.deploy_script, project.install_cmd, project.build_cmd, project.pre_deploy_cmd, project.post_deploy_cmd].filter(Boolean).join('\n')
    if (commands.toLowerCase().replace(/\\/g, '/').includes(project.root_path.toLowerCase().replace(/\\/g, '/'))) {
      throw new Error('Deployment commands reference the live directory. Use candidate-relative commands for isolated deployment')
    }
    if (/(?:^|[\n;&|])\s*(?:pm2|caddy|taskkill|net\s+stop|sc\s+stop)\b/i.test(commands)) {
      throw new Error('Deployment scripts cannot control live services; Manager activates the candidate after verification')
    }
    await requireGithubToken(project)
    const repoUrl = await withGithubToken(project)
    await prepareProjectParent(project.root_path)
    if (existsSync(path.join(project.root_path, '.git'))) await assertCleanDeploymentCheckout(command => git(command, project.root_path))
    const originalFingerprint = await sourceFingerprint(project.root_path, git)
    await release.prepare(git)
    await query('UPDATE deployments SET release_path=$1 WHERE id=$2', [release.base, deploymentId])
    await append('[release] Candidate: ' + root + '\n')
    if (!existsSync(path.join(root, '.git'))) {
      await loggedGit(`git clone --branch "${branch}" "${repoUrl}" "${root}"`, path.dirname(root))
    }
    // Authenticated clone/fetch URLs are ephemeral. Never persist a connection
    // token in the application's .git/config after deployment preparation.
    await loggedGit(`git remote set-url origin "${project.repo_url}"`)
    await stage('checkout')
    await loggedGit(`git fetch "${repoUrl}" "+refs/heads/${branch}:refs/remotes/origin/${branch}"`)
    if (options.commitSha) {
      await loggedGit(`git checkout --no-overwrite-ignore "${options.commitSha}"`)
    } else {
      await loggedGit(`git checkout --no-overwrite-ignore "${branch}"`)
      await syncDeploymentCheckout('origin/' + branch, command => git(command), append)
      if (options.mergeBranch) {
        const mergeBranch = options.mergeBranch
        await loggedGit(`git fetch "${repoUrl}" "+refs/heads/${mergeBranch}:refs/remotes/origin/${mergeBranch}"`)
        const merged = await git(`git merge "origin/${mergeBranch}" --no-autostash --no-overwrite-ignore --no-edit -m "Promote ${mergeBranch} to ${branch}"`)
        await append(merged.output)
        if (merged.code) { await git('git merge --abort'); throw new Error('Promotion merge conflict; resolve the branches before retrying') }
      }
    }
    const sha = (await git('git rev-parse HEAD')).output.trim()
    await query('UPDATE deployments SET commit_sha=$1,branch=$2 WHERE id=$3', [sha, branch, deploymentId])
    const candidateProject = { ...project, root_path: root }
    await prepareDeploymentProject(candidateProject, append)
    Object.assign(project, { project_type: candidateProject.project_type, install_cmd: candidateProject.install_cmd,
      build_cmd: candidateProject.build_cmd, start_cmd: candidateProject.start_cmd })
    getPm2StartCommand(project, project.root_path)
    const startCommand = getStartCommand(project)
    if (startCommand) managedStartCommand(startCommand, normalizeProjectType(project.project_type), project.port)
    const databaseEnv = { ...await getProjectDatabaseEnv(project.id), ...await getProjectDataServiceEnv(project.id) }
    const projectEnv = { ...loadProjectEnvFile(root, project.project_type), ...databaseEnv,
      ...projectRuntimeEnvironment(project.runtime_versions), ...getProjectPortEnvironment(project.project_type, project.port),
      BRANCH: branch, npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }
    const initialFileEnv = JSON.stringify(loadProjectEnvFile(project.root_path, project.project_type))
    const execute = (command: string, env: Record<string, string> = projectEnv, cwd = root) =>
      runDeploymentCommand(command, cwd, env, chunk => { void append(chunk).catch(() => {}) }, check)
    const inspect = (command: string) => runDeploymentCommand(command, root, { ...projectEnv, NODE_ENV: 'development' },
      () => {}, check, 0)
    // Reject vulnerable committed inputs before installation or builds. The
    // final candidate is audited again because scripts can change dependencies.
    if (existsSync(path.join(root, 'package.json')) && (existsSync(path.join(root, 'package-lock.json')) || existsSync(path.join(root, 'npm-shrinkwrap.json')))) {
      await stage('security')
      await append('[security] Checking committed dependencies before installation\n')
      const audit = await inspect('npm audit --json --package-lock-only --omit=dev --audit-level=high')
      const findings = formatAuditFindings(audit.output)
      if (findings) await append(findings)
      assertAuditPassed(audit, 'production dependencies')
      await append('[security] Committed dependency audit passed; final candidate will be checked again\n')
    }
    const prepared = async (command: string) => {
      const run = (cmd: string) => runPreparedDeploymentCommand(cmd, root,
        value => execute(value, { ...projectEnv, NODE_ENV: 'development' }), append, check)
      if (localNpmInstall(command)) {
        await stage('dependencies')
        return installWithDependencyCache({ command, root, cacheRoot: release.cache,
          env: { ...projectEnv, NODE_ENV: 'development' }, execute: run,
          executeInstall: cmd => withInstallationSlot(() => run(cmd), append, check),
          inspect, append, checkCancelled: check })
      }
      if (/\b(?:npm(?:\.cmd)?\s+(?:ci|install|i)\b|composer\s+(?:install|update)\b|go\s+mod\s+download\b)/i.test(command)) {
        await stage('dependencies')
        return withInstallationSlot(() => run(command), append, check)
      }
      return run(command)
    }
    const script = project.deploy_script?.trim()
    if (script) {
      await stage('script')
      await executeDeploymentScript(script, branch, prepared, append)
    } else {
      const install = await getInstallCommand(candidateProject)
      if (install && (await prepared(install)).code) throw new Error('Install failed')
    }
    if (!script) {
      if (project.pre_deploy_cmd) {
        await stage('pre-deploy')
        if ((await execute(project.pre_deploy_cmd)).code) throw new Error('Pre-deploy command failed')
      }
      await stage('build')
      const build = await getBuildCommand(candidateProject, command => execute(command), append)
      if (build && (await execute(build)).code) throw new Error('Build failed')
    }
    // Every final candidate is audited, including cache hits and custom deployment scripts.
    await stage('security')
    if (existsSync(path.join(root, 'package.json'))) {
      if (!existsSync(path.join(root, 'package-lock.json')) && !existsSync(path.join(root, 'npm-shrinkwrap.json'))) {
        throw new Error('Security gate requires an npm lockfile. Commit package-lock.json before deployment')
      }
      const audit = await inspect('npm audit --json --package-lock-only --omit=dev --audit-level=high')
      const findings = formatAuditFindings(audit.output)
      if (findings) await append(findings)
      const counts = assertAuditPassed(audit, 'production dependencies')
      await append(`[security] Production dependency audit passed: ${counts.low} low, ${counts.moderate} moderate, 0 high, 0 critical\n`)
      await query("UPDATE deployments SET security_status='passed' WHERE id=$1", [deploymentId])
    } else {
      await query("UPDATE deployments SET security_status='not_applicable' WHERE id=$1", [deploymentId])
      await append('[security] npm audit not applicable: no Node dependency manifest\n')
    }
    if (existsSync(path.join(root, 'composer.lock'))) {
      if ((await inspect('composer audit --locked --no-interaction')).code) throw new Error('Composer security audit failed; release blocked')
      await append('[security] Composer audit passed\n')
    }
    check()
    if (await sourceFingerprint(project.root_path, git) !== originalFingerprint) throw new Error('Live source changed during build; candidate not activated')
    if (initialFileEnv !== JSON.stringify(loadProjectEnvFile(project.root_path, project.project_type))) throw new Error('Application environment changed during build; retry with the current configuration')
    if (initialFileEnv !== '{}' && initialFileEnv !== JSON.stringify(loadProjectEnvFile(root, project.project_type))) throw new Error('Deployment commands changed private environment files. Apply environment changes in Manager before rebuilding')
    if (options.mergeBranch) await loggedGit(`git push "${repoUrl}" "${branch}"`)

    // Prove that the built candidate can actually boot and answer HTTP before
    // changing the live directory or stopping the current process.
    if (project.port) {
      await stage('preflight')
      previewPort = await allocateTemporaryPort()
      previewName = `${project.pm2_name}:candidate:${deploymentId.slice(0, 8)}`
      const previewProject = { ...project, port: previewPort, pm2_name: previewName }
      const previewEnv = getRuntimeEnv(previewProject, root, databaseEnv)
      await append(`[preflight] Starting candidate on temporary port ${previewPort}; current release remains online\n`)
      await pm2(getPm2StartCommand(previewProject, root), root, previewEnv)
      previewRunning = true
      const previewHealth = await waitForDeploymentHealth(previewPort, {
        checkProcess: timeout => getPm2ProcessStatus(previewName!, timeout), checkCancelled: check, onProgress: append })
      if (!previewHealth.healthy) throw new Error('Candidate preflight failed: ' + (previewHealth.reason || 'health check failed'))
      await append('[preflight] Candidate boot and HTTP health verified before activation\n')
      const domains = await query<{ hostname: string }>('select hostname from project_domains where project_id=$1 order by hostname', [project.id])
      projectDomains = domains.rows.map(row => row.hostname)
      if (!projectDomains.length || process.platform === 'win32') {
        await stopService(previewName, 'delete', normalizeProjectType(project.project_type) === 'laravel', root)
        previewRunning = false
        await append('[preflight] Verified candidate process shutdown before activation; current release remains online\n')
      }
    }
    previousStatus = await getPm2ProcessStatus(project.pm2_name, 15_000)
    if (!previousStatus) throw new Error('Cannot inspect current PM2 service')
    if (previousStatus !== 'missing') {
      const snapshot = await runCommand('pm2 jlist', undefined, 15_000)
      if (snapshot.code) throw new Error('Cannot capture the current service for rollback')
      const process = (JSON.parse(snapshot.output) as Array<{ name: string; pm2_env: Record<string, any> }>).find(item => item.name === project.pm2_name)
      const current = process?.pm2_env
      if (!current?.pm_exec_path || !current.pm_cwd) throw new Error('Incomplete PM2 process configuration; refusing activation without a rollback definition')
      const settings = Object.fromEntries(['args', 'node_args', 'instances', 'watch', 'ignore_watch', 'autorestart', 'max_memory_restart', 'kill_timeout', 'shutdown_with_message', 'listen_timeout', 'wait_ready', 'restart_delay', 'exp_backoff_restart_delay', 'log_date_format', 'merge_logs'].filter(key => current[key] !== undefined).map(key => [key, current[key]]))
      previousProcessFile = path.join(release.base, 'pm2-previous.config.json')
      // This generated file stays in the ACL-protected workspace and is never streamed to logs.
      await writeFile(previousProcessFile, JSON.stringify({ apps: [{ ...settings, name: project.pm2_name,
        script: current.pm_exec_path, cwd: current.pm_cwd, interpreter: current.exec_interpreter,
        exec_mode: current.exec_mode, env: current.env, out_file: current.pm_out_log_path, error_file: current.pm_err_log_path }] }))
    }
    // Pause admission of new project cron jobs, but give a short in-flight job time
    // to finish instead of discarding a fully verified candidate because of a race.
    const cronWaitStarted = Date.now()
    const cronWaitLimit = 5 * 60_000
    let cronNoticeSent = false
    let lastCronProgress = 0
    while (true) {
      check()
      const cron = await beginReleaseActivation(project.id, project.root_path, deploymentId)
      if (!cron) break
      const elapsed = Date.now() - cronWaitStarted
      if (!cronNoticeSent) {
        cronNoticeSent = true
        await query("update deployments set phase='waiting_cron' where id=$1", [deploymentId])
        await append(`[activation] Waiting for project cron job "${cron.name}" to finish; verified candidate remains ready and current release stays online\n`)
        await sendNotification(`Deployment waiting: ${project.name}`, `Project cron job "${cron.name}" is running. Activation will wait up to five minutes while the current release remains online.`, 'warning', [
          { name: 'Application', value: project.name },
          { name: 'Cron job', value: cron.name },
          { name: 'Trigger', value: options.trigger },
        ])
      } else if (elapsed - lastCronProgress >= 30_000) {
        lastCronProgress = elapsed
        await append(`[activation] Cron job still running (${Math.floor(elapsed / 1000)}s); activation has not started\n`)
      }
      if (elapsed >= cronWaitLimit) throw new Error(`Project cron job "${cron.name}" is still running after five minutes; current release was preserved`)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    if (cronNoticeSent) await append(`[activation] Project cron job finished; continuing with atomic activation\n`)
    await append('[stage] activate\n')
    const workers = await query<{ pm2_name: string }>('select pm2_name from workers where lower(working_directory)=lower($1)', [project.root_path])
    for (const worker of workers.rows) {
      if (!/^[A-Za-z0-9._:-]+$/.test(worker.pm2_name)) throw new Error('Invalid project worker PM2 name')
      if (await getPm2ProcessStatus(worker.pm2_name, 15_000) === 'online') {
        pausedWorkers.push(worker.pm2_name)
        await stopService(worker.pm2_name, 'stop')
      }
    }
    if (previewRunning && previewPort && projectDomains.length) {
      await append('[handoff] Routing managed domains to the verified candidate before stopping the previous release\n')
      await updateCaddyDomainsStrict(projectDomains, previewPort)
      caddyOnPreview = true
    }
    activating = true
    await stopService(project.pm2_name, 'delete', normalizeProjectType(project.project_type) === 'laravel')
    if (release.activationMode === 'contents') await append('[release] Keeping the Windows project root and persistent data in place; activating code with a rollback journal\n')
    try {
      await release.activate(async () => {
        check()
        await recoverProjectTerminalLocks(project.root_path, append)
      })
    } catch (error) {
      if (release.activationMode === 'contents') await logProjectDirectoryHandles(project.root_path, append)
      throw error
    }
    const runtimeEnv = getRuntimeEnv(project, project.root_path, databaseEnv)
    // Laravel caches embed absolute paths and must be generated at the stable runtime location.
    if (normalizeProjectType(project.project_type) === 'laravel') {
      for (const command of ['php artisan config:clear', 'php artisan route:clear', 'php artisan view:clear', 'php artisan config:cache', 'php artisan route:cache', 'php artisan view:cache']) {
        if ((await execute(command, runtimeEnv, project.root_path)).code) throw new Error('Laravel activation cache generation failed')
      }
    }
    await pm2(getPm2StartCommand(project, project.root_path), project.root_path, runtimeEnv)
    await stage('health')
    if (project.port) {
      const health = await waitForDeploymentHealth(project.port, {
        checkProcess: timeout => getPm2ProcessStatus(project.pm2_name, timeout), checkCancelled: check, onProgress: append })
      if (!health.healthy) throw new Error(health.reason || 'Candidate health check failed')
      await append('[health] OK\n')
    }
    if (caddyOnPreview && project.port) {
      await updateCaddyDomainsStrict(projectDomains, project.port)
      caddyOnPreview = false
      await append('[handoff] Managed domains switched to the verified release on its stable port\n')
    }
    if (previewRunning && previewName) {
      await stopService(previewName, 'delete', normalizeProjectType(project.project_type) === 'laravel', root)
      previewRunning = false
    }
    await query('UPDATE projects SET active_deployment_id=$1 WHERE id=$2', [deploymentId, project.id])
    accepted = true
    await release.complete()
    for (const name of pausedWorkers) await pm2(`pm2 restart "${name}"`)
    pausedWorkers.length = 0
    if (!script && project.post_deploy_cmd) {
      const post = await execute(project.post_deploy_cmd, runtimeEnv, project.root_path)
      if (post.code) await append('[post-deploy] Command failed; healthy release remains active\n')
    }
    await pm2('pm2 save')
    await append('[release] Active on original port; previous source retained at ' + release.previous + '\n')
    await flush()
    await query("UPDATE deployments SET status='success',phase='complete',finished_at=now(),log=$1 WHERE id=$2", [log, deploymentId])
    void notifyDeploy({ projectName: project.name, status: 'success', trigger: options.trigger, durationMs: Date.now() - started, commitSha: sha })
    return { deploymentId, status: 'success', log, commitSha: sha }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Deployment failed'
    cancelledDeployments.delete(deploymentId)
    await append('\n[error] ' + message + '\n')
    if (activating && !accepted) {
      try {
        await append('[rollback] Restoring previous application directory and service; database migrations are not reversed\n')
        await stopService(project.pm2_name, 'delete', normalizeProjectType(project.project_type) === 'laravel')
        await release.rollback()
        if (previousProcessFile) {
          await pm2(`pm2 start "${previousProcessFile}" --only "${project.pm2_name}"`)
          if (previousStatus === 'stopped') await pm2(`pm2 stop "${project.pm2_name}"`)
          if (previousStatus === 'online' && project.port) {
            const restored = await waitForDeploymentHealth(project.port, { checkProcess: timeout => getPm2ProcessStatus(project.pm2_name, timeout), checkCancelled: () => {}, onProgress: append })
            if (!restored.healthy) throw new Error('Previous process did not recover: ' + restored.reason)
            await append('[rollback] Previous release health verified\n')
          }
        }
        await pm2('pm2 save')
      } catch (recoveryError) {
        recoverable = false
        await append('[rollback] Recovery requires attention: ' + (recoveryError as Error).message + '\n')
      }
    } else if (!accepted) {
      if (existsSync(release.candidate)) {
        await append('[release] Current application was not replaced; failed candidate retained for inspection\n')
      } else if (existsSync(release.base)) {
        await append('[release] Current application was not replaced; incomplete release workspace retained for inspection\n')
      } else {
        await append('[release] Current application was not replaced; no release candidate was created\n')
      }
    }
    for (const name of recoverable ? pausedWorkers : []) {
      try { await pm2(`pm2 restart "${name}"`) } catch { await append('[worker] Restart requires attention: ' + name + '\n') }
    }
    if (caddyOnPreview && project.port && recoverable) {
      try {
        await updateCaddyDomainsStrict(projectDomains, project.port)
        caddyOnPreview = false
        await append('[rollback] Managed domains returned to the previous healthy release\n')
      } catch (caddyError) {
        recoverable = false
        await append('[rollback] Proxy recovery requires attention: ' + (caddyError as Error).message + '\n')
      }
    }
    if (previewRunning && previewName && !caddyOnPreview) {
      try { await stopService(previewName, 'delete', normalizeProjectType(project.project_type) === 'laravel', root) } catch { await append('[preflight] Candidate cleanup requires attention\n') }
      previewRunning = false
    }
    await query(`UPDATE deployments SET status=$1,phase=$2,security_status=case when phase='security' then 'failed' else security_status end,finished_at=now(),log=$3 WHERE id=$4`,
      [accepted ? 'success' : 'failed', accepted ? 'complete_with_warning' : 'failed', log, deploymentId])
    void notifyDeploy({ projectName: project.name, status: accepted ? 'success' : 'failed', trigger: options.trigger,
      durationMs: Date.now() - started, error: message })
    return { deploymentId, status: accepted ? 'success' : 'failed', log }
  } finally {
    activeDeployments.delete(deploymentId)
    cancelledDeployments.delete(deploymentId)
  }
}
