import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { getGitHubConnectionToken } from '@/lib/github-connections'
import { detectCheckoutProjectType, prepareProjectParent, prepareProjectCheckout } from '@/lib/deployment-preparation'
import { runCommand, killProcessTree } from '@/lib/exec'
import { projectRuntimeEnvironment } from '@/lib/runtimes'
import { detectGoBuildCommand } from '@/lib/deployment-go'
import { setupReady, validateSetupRepository, type SetupCheck, type SetupDecisions } from '@/lib/project-setup-policy'

let schema: Promise<void> | undefined
export function ensureProjectSetupSchema() {
  return schema ??= query(`create table if not exists project_setup (
    project_id uuid primary key references projects(id) on delete cascade,
    step text not null default 'repository', decisions jsonb not null default '{}',
    completed_at timestamptz, updated_at timestamptz not null default now()
  )`).then(() => undefined).catch(error => { schema = undefined; throw error })
}

export async function getProjectSetup(id: string) {
  await ensureProjectSetupSchema()
  const { rows } = await query(`select p.id,p.name,p.root_path,p.repo_url,p.default_branch,p.project_type,p.port,p.url,
    p.runtime_versions,p.build_cmd,p.start_cmd,p.deploy_script,p.github_connection_id,
    s.step,s.decisions,s.completed_at from projects p left join project_setup s on s.project_id=p.id where p.id=$1`, [id])
  if (!rows[0]) throw new ApiError('Application not found', 404)
  const project = rows[0]
  const checkout = existsSync(path.join(project.root_path, '.git'))
  let detectedType: string | undefined
  let inspectionError: string | undefined
  if (checkout) {
    try { detectedType = await detectCheckoutProjectType(project.root_path) } catch (error) { inspectionError = (error as Error).message }
  }
  return { project, checkout, detectedType, inspectionError, envExists: existsSync(path.join(project.root_path, '.env')) }
}

export async function checkProjectSetup(id: string): Promise<SetupCheck[]> {
  const { project, checkout, detectedType, inspectionError, envExists } = await getProjectSetup(id)
  const decisions: SetupDecisions = project.decisions || {}
  const checks: SetupCheck[] = []
  const add = (id: string, step: SetupCheck['step'], label: string, status: SetupCheck['status'], detail: string) => checks.push({ id, step, label, status, detail })
  add('checkout', 'repository', 'Repository checkout', checkout ? 'pass' : 'fail', checkout ? project.root_path : 'Prepare the repository before adding environment files')
  add('framework', 'runtime', 'Framework manifest', detectedType === project.project_type ? 'pass' : 'fail', inspectionError || (detectedType ? `Detected ${detectedType}; configured ${project.project_type}` : 'No unambiguous supported framework at the application root'))
  let runtimeEnv: Record<string, string> = {}
  try { runtimeEnv = projectRuntimeEnvironment(project.runtime_versions) } catch (error) { add('runtime-selection', 'runtime', 'Selected runtime', 'fail', (error as Error).message) }
  const commands = project.project_type === 'go' ? ['git --version', 'go version'] : project.project_type === 'laravel' ? ['git --version', 'php --version', 'composer --version'] : ['git --version', 'node --version', 'npm --version']
  if (project.project_type === 'laravel' && existsSync(path.join(project.root_path, 'package.json'))) commands.push('node --version', 'npm --version')
  for (const command of commands) {
    const result = await runCommand(command, undefined, 15000, undefined, runtimeEnv, false)
    add(command, 'runtime', command.split(' ')[0], result.code === 0 ? 'pass' : 'fail', result.code === 0 ? result.output.trim().split(/\r?\n/)[0].slice(0, 180) : 'Runtime unavailable. Install or select a runtime, then validate again.')
  }
  if (checkout) {
    try { await prepareProjectCheckout(project.root_path, project.project_type, () => {}); add('writable', 'repository', 'Application directory', 'pass', 'Required manifests present; directory is writable') }
    catch (error) { add('writable', 'repository', 'Application directory', 'fail', (error as Error).message) }
  }
  const services = await query('select id from project_data_services where project_id=$1', [id])
  const legacy = await query('select project_id from project_databases where project_id=$1', [id])
  const attached = services.rows.length > 0 || legacy.rows.length > 0
  add('database', 'database', 'Database configuration', attached ? 'pass' : decisions.database === 'none' ? 'warning' : 'fail', attached ? 'Attached. Credential checks run when connections are added; application migrations still require a successful deployment.' : decisions.database === 'none' ? 'No managed database selected' : 'Attach a database or explicitly choose no managed database')
  add('environment', 'environment', 'Environment configuration', envExists ? 'pass' : decisions.environment === 'runtime' ? 'warning' : 'fail', envExists ? '.env exists; values have not been printed or validated against application-specific requirements' : decisions.environment === 'runtime' ? 'Runtime variables only; application-specific secrets must be configured separately' : 'Save .env or explicitly choose runtime variables only')
  add('domain', 'domain', 'Public domain', project.url ? 'warning' : decisions.domain === 'later' ? 'warning' : 'fail', project.url ? `${project.url} configured. Public HTTP and certificate verification require a running deployment.` : decisions.domain === 'later' ? 'Domain deferred; the application will use its assigned local port' : 'Configure a domain or defer public access')
  add('port', 'review', 'Assigned application port', Number.isInteger(project.port) && project.port > 0 && project.port < 65536 ? 'pass' : 'fail', `Port ${project.port || 'not assigned'}`)
  if (checkout && project.project_type === 'go' && !project.build_cmd && !project.deploy_script) {
    try {
      const command = await detectGoBuildCommand(project.root_path, command => runCommand(command.replace('go list ', 'go list -e '), project.root_path, 30000, undefined, { ...runtimeEnv, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' }, false), () => {})
      add('go-entrypoint', 'runtime', 'Go entrypoint', 'pass', command)
    } catch (error) { add('go-entrypoint', 'runtime', 'Go entrypoint', 'fail', (error as Error).message) }
  }
  return checks
}

export async function assertProjectSetupComplete(id: string) {
  await ensureProjectSetupSchema()
  const { rows } = await query('select completed_at from project_setup where project_id=$1', [id])
  if (rows[0] && !rows[0].completed_at) throw new ApiError('Finish application setup and validation before deploying or enabling auto deploy', 409)
}

export async function completeProjectSetup(id: string) {
  const checks = await checkProjectSetup(id)
  if (setupReady(checks)) await query(`update project_setup set step='review',completed_at=now(),updated_at=now() where project_id=$1`, [id])
  else await query(`update project_setup set completed_at=null,updated_at=now() where project_id=$1 and not exists(select 1 from deployments where project_id=$1 and status='success')`, [id])
  return { checks, ready: setupReady(checks) }
}

export async function prepareSetupRepository(id: string, append: (text: string) => void, signal: AbortSignal) {
  const { project, checkout } = await getProjectSetup(id)
  if (checkout) { append('[repository] Existing checkout preserved; no pull, reset or checkout was performed.\n'); return }
  validateSetupRepository(project.repo_url || '', project.default_branch)
  const root = path.resolve(project.root_path)
  await prepareProjectParent(root)
  if (existsSync(root) && (await readdir(root)).length) throw new ApiError('Directory is not empty and is not a Git checkout. Choose an empty application directory; existing files will not be removed.', 409)
  const parent = await realpath(path.dirname(root))
  const manager = await realpath(process.cwd())
  if (root.toLowerCase() === manager.toLowerCase() || parent.toLowerCase() === manager.toLowerCase() || parent.toLowerCase().startsWith(manager.toLowerCase() + path.sep)) throw new ApiError('Application directory cannot be inside Manager', 400)
  const token = await getGitHubConnectionToken(project.github_connection_id)
  const runtimeEnv = projectRuntimeEnvironment({})
  const env: NodeJS.ProcessEnv = { ...runtimeEnv, NODE_ENV: 'production', Path: process.env.Path || process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: process.env.USERPROFILE, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', GIT_CONFIG_COUNT: token ? '2' : '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' }
  if (token) { env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_1 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
  append(`[repository] Cloning ${project.default_branch}\n`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['clone', '--progress', '--branch', project.default_branch, '--', project.repo_url, root], { shell: false, windowsHide: true, env })
    const abort = () => { if (child.pid) killProcessTree(child.pid) }
    const timer = setTimeout(abort, 300000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    // Git never receives a credential-bearing URL. Do not stream server-supplied URL errors.
    child.stderr.on('data', chunk => {
      const text = chunk.toString()
      if (/^(Cloning|remote: (Enumerating|Counting|Compressing|Total)|Receiving objects|Resolving deltas|Updating files)/m.test(text)) append(text)
    })
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    child.once('error', () => { cleanup(); reject(new Error('Git could not start. Check the host Git installation.')) })
    child.once('close', code => { cleanup(); code === 0 ? resolve() : reject(new Error('Repository preparation failed. Check repository access, branch and Git installation. Existing files were preserved.')) })
  })
  append('[repository] Checkout ready.\n')
}
