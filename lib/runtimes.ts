import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { db, query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { ApiError } from '@/lib/api'

export type RuntimeId = 'git' | 'node' | 'go' | 'angular' | 'php' | 'composer' | 'postgresql' | 'caddy' | 'sling' | 'mysql' | 'mariadb' | 'sqlserver' | 'mongodb' | 'redis' | 'phpmyadmin'
export type VersionedRuntimeId = 'node' | 'php' | 'go'
export type RuntimeJobAction = 'install' | 'update' | 'configure' | 'install-version'
type RuntimeJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'interrupted'

interface RuntimeDefinition {
  id: RuntimeId
  name: string
  purpose: string
  command: string
  versionCommand: string
  installCommand: string | null
  updateCommand: string | null
  packageName?: string
  candidates?: string[]
}

export interface RuntimeJob {
  id: string
  runtime_id: RuntimeId
  action: RuntimeJobAction
  requested_version: string | null
  status: RuntimeJobStatus
  log: string
  error: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

const definitions: RuntimeDefinition[] = [
  { id: 'git', name: 'Git', purpose: 'Repository checkout and deployment', command: 'git', versionCommand: 'git --version', packageName: 'git', installCommand: 'choco install git -y', updateCommand: 'choco upgrade git -y' },
  { id: 'node', name: 'Node.js', purpose: 'Host default for Next.js, Angular, and Node applications', command: 'node', versionCommand: 'node --version', packageName: 'nodejs-lts', installCommand: 'choco install nodejs-lts -y', updateCommand: 'choco upgrade nodejs-lts -y' },
  { id: 'go', name: 'Go', purpose: 'Host default for compiling Go services', command: 'go', versionCommand: 'go version', packageName: 'golang', installCommand: 'choco install golang -y', updateCommand: 'choco upgrade golang -y', candidates: ['C:\\Program Files\\Go\\bin\\go.exe'] },
  { id: 'angular', name: 'Angular CLI', purpose: 'Host convenience CLI; project-local Angular remains preferred', command: 'ng', versionCommand: 'ng version', installCommand: 'cmd /c npm.cmd install -g @angular/cli', updateCommand: 'cmd /c npm.cmd install -g @angular/cli@latest', candidates: [process.env.APPDATA ? `${process.env.APPDATA}\\npm\\ng.cmd` : ''] },
  { id: 'php', name: 'PHP', purpose: 'Host default for Laravel and PHP applications', command: 'php', versionCommand: 'php --version', packageName: 'php', installCommand: 'choco install php -y', updateCommand: 'choco upgrade php -y' },
  { id: 'composer', name: 'Composer', purpose: 'PHP dependency management', command: 'composer', versionCommand: 'composer --version', packageName: 'composer', installCommand: 'choco install composer -y', updateCommand: 'choco upgrade composer -y' },
  { id: 'postgresql', name: 'PostgreSQL tools', purpose: 'psql, pg_dump, and pg_restore', command: 'psql', versionCommand: 'psql --version', installCommand: null, updateCommand: null, candidates: ['C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe'] },
  { id: 'caddy', name: 'Caddy', purpose: 'Reverse proxy and automatic TLS', command: 'caddy', versionCommand: 'caddy version', packageName: 'caddy', installCommand: 'choco install caddy -y', updateCommand: 'choco upgrade caddy -y', candidates: [process.env.CADDY_EXE || 'C:\\web\\caddy.exe'] },
  { id: 'sling', name: 'Sling migration engine', purpose: 'Verified cross-provider database transfer runtime', command: 'sling', versionCommand: 'sling --version', installCommand: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-sling.ps1"', updateCommand: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-sling.ps1" -Latest', candidates: [process.env.SLING_EXE || 'C:\\web\\tools\\sling\\sling.exe'] },
  { id: 'mysql', name: 'MySQL', purpose: 'Project database engine with secured phpMyAdmin access', command: 'mysql', versionCommand: 'mysql --version', packageName: 'mysql', installCommand: 'choco install mysql -y', updateCommand: 'choco upgrade mysql -y', candidates: ['C:\\tools\\mysql\\current\\bin\\mysql.exe'] },
  { id: 'phpmyadmin', name: 'phpMyAdmin', purpose: 'Admin-only web client for MySQL and MariaDB', command: 'manager-phpmyadmin', versionCommand: `powershell.exe -NoLogo -NoProfile -Command "Get-Content -LiteralPath 'C:\\web\\tools\\phpmyadmin\\VERSION' -TotalCount 1"`, installCommand: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-phpmyadmin.ps1"', updateCommand: 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-phpmyadmin.ps1" -Latest' },
  { id: 'mariadb', name: 'MariaDB', purpose: 'Project database engine with secured phpMyAdmin access', command: 'mariadb', versionCommand: 'mariadb --version', packageName: 'mariadb', installCommand: 'choco install mariadb -y', updateCommand: 'choco upgrade mariadb -y' },
  { id: 'sqlserver', name: 'SQL Server tools', purpose: 'SQL Server project database administration', command: 'sqlcmd', versionCommand: 'sqlcmd -?', packageName: 'sql-server-express', installCommand: 'choco install sql-server-express -y', updateCommand: 'choco upgrade sql-server-express -y' },
  { id: 'mongodb', name: 'MongoDB', purpose: 'Optional document database engine', command: 'mongod', versionCommand: 'mongod --version', packageName: 'mongodb', installCommand: 'choco install mongodb -y', updateCommand: 'choco upgrade mongodb -y' },
  { id: 'redis', name: 'Redis', purpose: 'Register a remote or supported Windows-compatible Redis service', command: 'redis-server', versionCommand: 'redis-server --version', installCommand: null, updateCommand: null },
]

const versionedRuntimeIds: VersionedRuntimeId[] = ['node', 'php', 'go']
let runtimeSchemaPromise: Promise<void> | null = null

export function ensureRuntimeSchema() {
  if (!runtimeSchemaPromise) {
    runtimeSchemaPromise = query(`
      create table if not exists runtime_jobs (
        id uuid primary key default gen_random_uuid(),
        runtime_id text not null,
        action text not null check (action in ('install','update','configure','install-version')),
        requested_version text,
        status text not null default 'queued' check (status in ('queued','running','success','failed','interrupted')),
        log text not null default '',
        error text,
        requested_by uuid references users(id) on delete set null,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists runtime_jobs_created_idx on runtime_jobs (created_at desc);
      create index if not exists runtime_jobs_active_idx on runtime_jobs (status) where status in ('queued','running');
      create table if not exists runtime_update_status (
        runtime_id text primary key,
        current_version text,
        latest_version text,
        update_available boolean not null default false,
        checked_at timestamptz not null default now()
      );
      alter table projects add column if not exists runtime_versions jsonb not null default '{}'::jsonb
    `).then(() => undefined).catch((error) => { runtimeSchemaPromise = null; throw error })
  }
  return runtimeSchemaPromise
}

function definitionFor(id: string) {
  const definition = definitions.find((item) => item.id === id)
  if (!definition) throw new ApiError('Unsupported runtime', 400)
  return definition
}

function executable(definition: RuntimeDefinition) {
  const candidate = definition.candidates?.find((item) => item && existsSync(item))
  return candidate ? `"${candidate}"` : definition.command
}

function runtimeEnv(id: RuntimeId) {
  return id === 'sling' ? { AWS_EC2_METADATA_DISABLED: 'true' } : undefined
}

function updateRisk(current: string | null | undefined, latest: string | null | undefined) {
  const currentParts = current?.match(/\d+\.\d+\.\d+/)?.[0].split('.').map(Number)
  const latestParts = latest?.match(/\d+\.\d+\.\d+/)?.[0].split('.').map(Number)
  if (!currentParts || !latestParts) return null
  if (currentParts[0] !== latestParts[0]) return 'major'
  if (currentParts[1] !== latestParts[1]) return 'minor'
  return 'patch'
}

async function inspectRuntime(definition: RuntimeDefinition) {
  const result = await runCommand(`${executable(definition)} --version`, undefined, 15_000, undefined, runtimeEnv(definition.id))
  const versionResult = result.code === 0 ? result : await runCommand(definition.versionCommand, undefined, 15_000, undefined, runtimeEnv(definition.id))
  return { installed: versionResult.code === 0, version: versionResult.code === 0 ? versionResult.output.trim().split(/\r?\n/)[0].slice(0, 160) : null }
}

export function getInstalledRuntimeVersions(id: VersionedRuntimeId) {
  const root = path.join('C:\\web\\tools', id)
  if (!existsSync(root)) return []
  const executablePath = (version: string) => id === 'node'
    ? path.join(root, version, 'node.exe')
    : id === 'php' ? path.join(root, version, 'php.exe') : path.join(root, version, 'bin', 'go.exe')
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && existsSync(executablePath(entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
}

export function projectRuntimeEnvironment(runtimeVersions: Record<string, unknown> | null | undefined) {
  const paths: string[] = []
  const selected: Record<string, string> = {}
  for (const id of versionedRuntimeIds) {
    const version = typeof runtimeVersions?.[id] === 'string' ? runtimeVersions[id] as string : ''
    if (!version) continue
    if (!/^\d+\.\d+\.\d+$/.test(version) || !getInstalledRuntimeVersions(id).includes(version)) {
      throw new Error(`${id} ${version} is not installed on this host`)
    }
    const root = path.join('C:\\web\\tools', id, version)
    paths.push(id === 'go' ? path.join(root, 'bin') : root)
    selected[`MANAGER_${id.toUpperCase()}_VERSION`] = version
  }
  if (!paths.length) return selected
  const inheritedPath = process.env.Path || process.env.PATH || ''
  return { ...selected, Path: [...paths, inheritedPath].join(';'), PATH: [...paths, inheritedPath].join(';') }
}

export function validateProjectRuntimeVersions(value: unknown) {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ApiError('Runtime versions must be an object', 400)
  const validated: Record<string, string> = {}
  for (const [id, rawVersion] of Object.entries(value as Record<string, unknown>)) {
    if (!versionedRuntimeIds.includes(id as VersionedRuntimeId)) throw new ApiError(`Unsupported project runtime: ${id}`, 400)
    if (rawVersion === '' || rawVersion === null) continue
    const version = String(rawVersion)
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ApiError(`Invalid ${id} version`, 400)
    if (!getInstalledRuntimeVersions(id as VersionedRuntimeId).includes(version)) throw new ApiError(`${id} ${version} is not installed on this host`, 409)
    validated[id] = version
  }
  return validated
}

export async function listRuntimeJobs(limit = 25) {
  await ensureRuntimeSchema()
  const { rows } = await query<RuntimeJob>('select id,runtime_id,action,requested_version,status,log,error,started_at,finished_at,created_at from runtime_jobs order by created_at desc limit $1', [limit])
  return rows
}

export async function getRuntimeJob(id: string) {
  await ensureRuntimeSchema()
  const { rows } = await query<RuntimeJob>('select id,runtime_id,action,requested_version,status,log,error,started_at,finished_at,created_at from runtime_jobs where id=$1', [id])
  if (!rows[0]) throw new ApiError('Runtime job not found', 404)
  return rows[0]
}

export async function listRuntimes() {
  await ensureRuntimeSchema()
  const [jobs, updates, ...inspections] = await Promise.all([
    listRuntimeJobs(25),
    query<{ runtime_id: string; current_version: string | null; latest_version: string | null; update_available: boolean; checked_at: string }>('select * from runtime_update_status'),
    ...definitions.map(inspectRuntime),
  ])
  const updateMap = new Map(updates.rows.map((item) => [item.runtime_id, item]))
  return definitions.map((definition, index) => {
    const activeJob = jobs.find((job) => job.runtime_id === definition.id && ['queued', 'running'].includes(job.status)) || null
    const latestJob = jobs.find((job) => job.runtime_id === definition.id) || null
    const update = updateMap.get(definition.id)
    return {
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      ...inspections[index],
      canInstall: !!definition.installCommand,
      canUpdate: !!definition.updateCommand,
      canConfigure: definition.id === 'mysql',
      versioned: versionedRuntimeIds.includes(definition.id as VersionedRuntimeId),
      installedVersions: versionedRuntimeIds.includes(definition.id as VersionedRuntimeId) ? getInstalledRuntimeVersions(definition.id as VersionedRuntimeId) : [],
      updateAvailable: update?.update_available || false,
      latestVersion: update?.latest_version || null,
      updateRisk: update?.update_available ? updateRisk(update.current_version, update.latest_version) : null,
      updateCheckedAt: update?.checked_at || null,
      activeJob,
      latestJob,
    }
  })
}

async function appendRuntimeLog(jobId: string, chunk: string) {
  await query(`update runtime_jobs set log=right(log || $1,1000000),updated_at=now() where id=$2`, [chunk, jobId])
}

function runtimeJobCommand(runtimeId: RuntimeId, action: RuntimeJobAction, requestedVersion?: string | null) {
  const definition = definitionFor(runtimeId)
  if (action === 'install-version') {
    if (!versionedRuntimeIds.includes(runtimeId as VersionedRuntimeId) || !requestedVersion || !/^\d+\.\d+\.\d+$/.test(requestedVersion)) throw new ApiError('Choose a valid side-by-side runtime version', 400)
    return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-runtime-version.ps1" -Runtime ${runtimeId} -Version ${requestedVersion}`
  }
  if (action === 'configure') {
    if (runtimeId !== 'mysql') throw new ApiError('This runtime has no Manager configuration step', 400)
    return 'cmd /c echo [configure] Checking MySQL and Manager provisioning setup'
  }
  const command = action === 'update' ? definition.updateCommand : definition.installCommand
  if (!command) throw new ApiError(`${definition.name} does not support ${action} from Manager`, 409)
  return command
}

async function activatePhpMyAdmin(jobId: string, installIfMissing: boolean) {
  const versionFile = 'C:\\web\\tools\\phpmyadmin\\VERSION'
  if (!existsSync(versionFile)) {
    if (!installIfMissing) throw new Error('phpMyAdmin installation did not produce a version marker')
    await appendRuntimeLog(jobId, '[dependency] Installing the secured phpMyAdmin client for this database engine\n')
    let logQueue = Promise.resolve()
    const installer = await runCommand(
      'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\web\\manager\\scripts\\install-phpmyadmin.ps1"',
      undefined,
      10 * 60_000,
      (chunk) => { logQueue = logQueue.then(() => appendRuntimeLog(jobId, chunk)) },
    )
    await logQueue
    if (installer.code !== 0 || !existsSync(versionFile)) throw new Error('phpMyAdmin dependency installation failed')
  }

  const runner = path.join(process.cwd(), 'scripts', 'pm2-phpmyadmin-runner.js')
  const existing = await runCommand('pm2 describe "manager-phpmyadmin"')
  const command = existing.code === 0
    ? 'pm2 restart "manager-phpmyadmin"'
    : `pm2 start "${runner}" --interpreter node --name "manager-phpmyadmin"`
  const service = await runCommand(command, process.cwd(), 60_000, undefined, { MANAGER_ROOT: process.cwd() }, false)
  if (service.code !== 0) throw new Error('phpMyAdmin PM2 service could not be started')
  await runCommand('pm2 save')
  const { updateCaddyStrict } = await import('@/lib/caddy')
  await updateCaddyStrict(process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com', Number(process.env.MANAGER_PORT || 4000))
  await appendRuntimeLog(jobId, '[service] phpMyAdmin is running on the admin-protected /mysql route\n')
}

async function executeRuntimeJob(jobId: string) {
  const job = await getRuntimeJob(jobId)
  const claimed = await query(`update runtime_jobs set status='running',started_at=now(),error=null,updated_at=now() where id=$1 and status='queued' returning id`, [jobId])
  if (!claimed.rowCount) return
  const definition = definitionFor(job.runtime_id)
  try {
    await appendRuntimeLog(jobId, `[runtime] ${definition.name} ${job.action}${job.requested_version ? ` ${job.requested_version}` : ''}\n`)
    const command = runtimeJobCommand(job.runtime_id, job.action, job.requested_version)
    let logQueue = Promise.resolve()
    const result = await runCommand(command, undefined, 30 * 60_000, (chunk) => { logQueue = logQueue.then(() => appendRuntimeLog(jobId, chunk)) }, runtimeEnv(job.runtime_id))
    await logQueue
    if (result.code !== 0) throw new Error(`${definition.name} ${job.action} exited with code ${result.code}`)
    if (job.runtime_id === 'mysql' && job.action !== 'install-version') {
      await appendRuntimeLog(jobId, '[security] Restricting MySQL network listeners to this host\n')
      const binding = await runCommand(
        `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(process.cwd(), 'scripts', 'configure-database-loopback.ps1')}" -Engine mysql -RepairMissingService`,
        undefined,
        2 * 60_000,
        (chunk) => { logQueue = logQueue.then(() => appendRuntimeLog(jobId, chunk)) },
      )
      await logQueue
      if (binding.code !== 0) throw new Error('MySQL loopback security configuration failed')
      const { configureManagedMySqlRuntime } = await import('@/lib/data-services')
      await appendRuntimeLog(jobId, '[configure] Verifying MySQL service and project provisioning credential\n')
      const configuration = await configureManagedMySqlRuntime()
      await appendRuntimeLog(jobId, configuration.reused
        ? '[configure] Existing encrypted provisioning credential is healthy; no credentials were changed\n'
        : '[configure] Fresh MySQL setup was secured and a dedicated provisioning credential was registered\n')
    }
    if (job.runtime_id === 'mariadb' && job.action !== 'install-version') {
      await appendRuntimeLog(jobId, '[security] Restricting MariaDB network listeners to this host\n')
      const binding = await runCommand(
        `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(process.cwd(), 'scripts', 'configure-database-loopback.ps1')}" -Engine mariadb`,
        undefined,
        2 * 60_000,
        (chunk) => { logQueue = logQueue.then(() => appendRuntimeLog(jobId, chunk)) },
      )
      await logQueue
      if (binding.code !== 0) throw new Error('MariaDB loopback security configuration failed')
    }
    if (job.runtime_id === 'phpmyadmin') await activatePhpMyAdmin(jobId, false)
    if (job.action === 'install-version') {
      if (!getInstalledRuntimeVersions(job.runtime_id as VersionedRuntimeId).includes(job.requested_version || '')) throw new Error('Installed runtime version could not be verified')
    } else {
      const inspection = await inspectRuntime(definition)
      if (!inspection.installed) throw new Error(`${definition.name} was not detected after ${job.action}`)
      await appendRuntimeLog(jobId, `[verify] ${inspection.version}\n`)
    }
    if (job.runtime_id === 'mysql' || job.runtime_id === 'mariadb') await activatePhpMyAdmin(jobId, true)
    await query(`update runtime_jobs set status='success',finished_at=now(),updated_at=now() where id=$1`, [jobId])
  } catch (error) {
    const message = error instanceof Error ? error.message : `${definition.name} operation failed`
    await appendRuntimeLog(jobId, `\n[failed] ${message}\n`)
    await query(`update runtime_jobs set status='failed',error=$1,finished_at=now(),updated_at=now() where id=$2`, [message.slice(0, 2000), jobId])
  }
}

export async function startRuntimeJob(runtimeId: string, action: RuntimeJobAction, requestedVersion: string | null, requestedBy?: string | null) {
  await ensureRuntimeSchema()
  definitionFor(runtimeId)
  runtimeJobCommand(runtimeId as RuntimeId, action, requestedVersion)
  const client = await db.connect()
  let jobId = ''
  try {
    await client.query('begin')
    await client.query(`select pg_advisory_xact_lock(hashtext('manager:runtime-jobs'))`)
    const active = await client.query<{ id: string }>(`select id from runtime_jobs where status in ('queued','running') limit 1`)
    if (active.rows[0]) throw new ApiError('Another host dependency operation is already running', 409)
    if (action !== 'install-version') {
      const deployment = await client.query<{ id: string }>(`select id from deployments where status in ('queued','running') limit 1`)
      if (deployment.rows[0]) throw new ApiError('Host dependency changes are blocked while an application deployment is active', 409)
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into runtime_jobs (runtime_id,action,requested_version,requested_by) values ($1,$2,$3,$4) returning id`,
      [runtimeId, action, requestedVersion || null, requestedBy || null]
    )
    jobId = rows[0].id
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally { client.release() }
  setImmediate(() => void executeRuntimeJob(jobId))
  return getRuntimeJob(jobId)
}

export async function checkRuntimeUpdates() {
  await ensureRuntimeSchema()
  const packageMap = new Map(definitions.filter((item) => item.packageName).map((item) => [item.packageName!.toLowerCase(), item.id]))
  const result = await runCommand('choco outdated --limit-output --ignore-pinned', undefined, 5 * 60_000)
  const found = new Map<RuntimeId, { current: string; latest: string }>()
  for (const line of result.output.split(/\r?\n/)) {
    const [packageName, current, latest] = line.trim().split('|')
    const id = packageMap.get((packageName || '').toLowerCase())
    if (id && current && latest) found.set(id, { current, latest })
  }
  const angular = definitions.find((item) => item.id === 'angular')!
  const angularCurrent = await inspectRuntime(angular)
  const angularLatest = await runCommand('cmd /c npm.cmd view @angular/cli version', undefined, 60_000)
  const angularCurrentVersion = angularCurrent.version?.match(/\d+\.\d+\.\d+/)?.[0]
  const angularLatestVersion = angularLatest.output.match(/\d+\.\d+\.\d+/)?.[0]
  if (angularCurrentVersion && angularLatestVersion && angularCurrentVersion !== angularLatestVersion) found.set('angular', { current: angularCurrentVersion, latest: angularLatestVersion })
  try {
    const slingCurrent = await inspectRuntime(definitionFor('sling'))
    const response = await fetch('https://api.github.com/repos/slingdata-io/sling-cli/releases/latest', { headers: { 'User-Agent': 'Manager-Runtime-Updater' }, cache: 'no-store' })
    const release = response.ok ? await response.json() as { tag_name?: string } : null
    const current = slingCurrent.version?.match(/\d+\.\d+\.\d+/)?.[0]
    const latest = release?.tag_name?.replace(/^v/, '')
    if (current && latest && current !== latest) found.set('sling', { current, latest })
  } catch {
    // A transient catalog error does not hide Chocolatey update results.
  }
  try {
    const phpMyAdminCurrent = await inspectRuntime(definitionFor('phpmyadmin'))
    const response = await fetch('https://www.phpmyadmin.net/home_page/version.json', { cache: 'no-store' })
    const release = response.ok ? await response.json() as { version?: string } : null
    const current = phpMyAdminCurrent.version?.match(/\d+\.\d+\.\d+/)?.[0]
    const latest = release?.version
    if (current && latest && current !== latest) found.set('phpmyadmin', { current, latest })
  } catch {
    // A transient catalog error does not hide other update results.
  }
  for (const definition of definitions) {
    const update = found.get(definition.id)
    await query(
      `insert into runtime_update_status (runtime_id,current_version,latest_version,update_available,checked_at)
       values ($1,$2,$3,$4,now()) on conflict (runtime_id) do update set current_version=excluded.current_version,
       latest_version=excluded.latest_version,update_available=excluded.update_available,checked_at=now()`,
      [definition.id, update?.current || null, update?.latest || null, !!update]
    )
  }
  return listRuntimes()
}

export async function getRuntimeVersionCatalog(id: string) {
  if (!versionedRuntimeIds.includes(id as VersionedRuntimeId)) throw new ApiError('This runtime does not support side-by-side versions', 400)
  const runtimeId = id as VersionedRuntimeId
  let available: Array<{ version: string; label: string; date?: string }> = []
  if (runtimeId === 'node') {
    const response = await fetch('https://nodejs.org/dist/index.json', { cache: 'no-store' })
    if (!response.ok) throw new ApiError('Node.js release catalog is unavailable', 502)
    const releases = await response.json() as Array<{ version: string; date: string; lts: string | false; files: string[] }>
    const seen = new Set<string>()
    available = releases.filter((item) => item.lts && item.files.includes('win-x64-zip')).filter((item) => {
      const major = item.version.split('.')[0]
      if (seen.has(major)) return false
      seen.add(major); return true
    }).slice(0, 5).map((item) => ({ version: item.version.replace(/^v/, ''), label: `Node.js ${item.version.replace(/^v/, '')} LTS (${item.lts})`, date: item.date }))
  } else if (runtimeId === 'php') {
    const response = await fetch('https://windows.php.net/downloads/releases/releases.json', { cache: 'no-store' })
    if (!response.ok) throw new ApiError('PHP Windows release catalog is unavailable', 502)
    const catalog = await response.json() as Record<string, { version: string }>
    available = Object.values(catalog).filter((item) => /^8\.[1-9]\./.test(item.version)).map((item) => ({ version: item.version, label: `PHP ${item.version} NTS x64` })).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  } else {
    const response = await fetch('https://go.dev/dl/?mode=json&include=all', { cache: 'no-store' })
    if (!response.ok) throw new ApiError('Go release catalog is unavailable', 502)
    const releases = await response.json() as Array<{ version: string; stable: boolean; files: Array<{ os: string; arch: string; kind: string }> }>
    available = releases.filter((item) => item.stable && item.files.some((file) => file.os === 'windows' && file.arch === 'amd64' && file.kind === 'archive')).slice(0, 8).map((item) => ({ version: item.version.replace(/^go/, ''), label: `Go ${item.version.replace(/^go/, '')}` }))
  }
  return { runtime: runtimeId, available, installed: getInstalledRuntimeVersions(runtimeId) }
}

export async function recoverInterruptedRuntimeJobs() {
  await ensureRuntimeSchema()
  await query(`update runtime_jobs set status='interrupted',error='Manager restarted during host dependency operation',finished_at=now(),updated_at=now() where status in ('queued','running')`)
}
