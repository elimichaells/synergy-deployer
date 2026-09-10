import { copyFile, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { parse as parseEnv } from 'dotenv'
import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { getProjectDataServiceEnv } from '@/lib/data-services'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { requireRole } from '@/lib/rbac'
import { projectRuntimeEnvironment } from '@/lib/runtimes'

const ALLOWED_ENV_FILES = ['.env', '.env.local']
const MANAGED_START = '# >>> Manager project data services'
const MANAGED_END = '# <<< Manager project data services'
const CONTROL_PLANE_KEYS = ['JWT_SECRET', 'MANAGER_ENCRYPTION_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD']

function frameworkIdentityKeys(projectType: string) {
  if (projectType === 'laravel') return ['DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME']
  if (projectType === 'go') return ['DB_DRIVER', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER']
  if (projectType === 'next' || projectType === 'node') return ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER']
  return ['MONGODB_URI', 'REDIS_URL']
}

async function databaseRuntimeBlockers(projectType: string, provider: string | undefined, rootPath: string, runtimeVersions: Record<string, string>) {
  if (projectType !== 'laravel' || !provider) return []
  const requiredExtension = provider === 'postgresql' ? 'pdo_pgsql' : ['mysql', 'mariadb'].includes(provider) ? 'pdo_mysql' : provider === 'sqlserver' ? 'pdo_sqlsrv' : null
  if (!requiredExtension) return []
  const result = await runCommand('php -m', rootPath, 15_000, undefined, projectRuntimeEnvironment(runtimeVersions), false)
  if (result.code !== 0) return ['The selected PHP runtime could not be inspected.']
  const extensions = new Set(result.output.split(/\r?\n/).map((line) => line.trim().toLowerCase()))
  return extensions.has(requiredExtension) ? [] : [`The selected PHP runtime does not have ${requiredExtension} enabled.`]
}

function quotedEnvValue(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
}

function mergeEnv(content: string, values: Record<string, string>) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const managedKeys = new Set(Object.keys(values))
  const merged: string[] = []
  let inManagedBlock = false
  for (const line of content ? content.split(/\r?\n/) : []) {
    if (line.trim() === MANAGED_START) { inManagedBlock = true; continue }
    if (line.trim() === MANAGED_END) { inManagedBlock = false; continue }
    if (inManagedBlock) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match && managedKeys.has(match[1])) continue
    merged.push(line)
  }
  while (merged.length && merged[merged.length - 1] === '') merged.pop()
  if (merged.length) merged.push('')
  merged.push(MANAGED_START)
  for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
    merged.push(`${key}=${quotedEnvValue(value)}`)
  }
  merged.push(MANAGED_END)
  return `${merged.join(newline)}${newline}`
}

function managedBlockKeys(content: string) {
  const keys = new Set<string>()
  let inManagedBlock = false
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === MANAGED_START) { inManagedBlock = true; continue }
    if (line.trim() === MANAGED_END) { inManagedBlock = false; continue }
    if (!inManagedBlock) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (match) keys.add(match[1])
  }
  return keys
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const projectId = (await context.params).id
    const body = await request.json().catch(() => ({}))
    const fileName = typeof body.file === 'string' ? body.file : '.env'
    if (!ALLOWED_ENV_FILES.includes(fileName)) throw new ApiError('Unsupported env file', 400)

    const { rows } = await query<{ root_path: string; pm2_name: string; project_type: string; runtime_versions: Record<string, string> }>('select root_path,pm2_name,project_type,runtime_versions from projects where id=$1', [projectId])
    if (!rows[0]) throw new ApiError('Project not found', 404)
    if (rows[0].project_type === 'laravel' && fileName !== '.env') throw new ApiError('Laravel database credentials must be synced to .env', 400)
    const values = await getProjectDataServiceEnv(projectId)
    if (!Object.keys(values).length) throw new ApiError('This project has no managed data-service credentials', 409)

    const filePath = path.join(rows[0].root_path, fileName)
    let current = ''
    try {
      current = await readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const currentValues = parseEnv(current)
    const identityKeys = frameworkIdentityKeys(rows[0].project_type)
    const hasExistingApplicationDatabase = identityKeys.some((key) => currentValues[key])
    const changesApplicationDatabase = hasExistingApplicationDatabase && identityKeys.some((key) => values[key] !== undefined && currentValues[key] !== values[key])
    const changedKeys = Object.keys(values).filter((key) => currentValues[key] !== values[key]).sort()
    const activeResult = await query<{ id: string; name: string; provider: string; database_name: string }>(
      `select pds.id,pds.name,dc.provider,pds.database_name
         from project_data_services pds join data_connections dc on dc.id=pds.connection_id
        where pds.project_id=$1 and pds.application_primary=true limit 1`,
      [projectId]
    )
    const runtimeBlockers = await databaseRuntimeBlockers(rows[0].project_type, activeResult.rows[0]?.provider, rows[0].root_path, rows[0].runtime_versions)
    const preview = {
      file: fileName,
      projectType: rows[0].project_type,
      keys: Object.keys(values).sort(),
      changedKeys,
      changesApplicationDatabase,
      activeService: activeResult.rows[0] || null,
      runtimeBlockers,
    }
    if (body.preview === true) return NextResponse.json({ ok: true, preview: true, ...preview })
    if (runtimeBlockers.length) throw new ApiError(runtimeBlockers.join(' '), 409)
    if (changesApplicationDatabase && body.confirmApplicationChange !== true) {
      throw new ApiError('Confirm the application database change before syncing this environment', 409)
    }

    let backupFile: string | null = null
    try {
      await readFile(filePath, 'utf8')
      const timestamp = new Date().toISOString().replace(/[-:.]/g, '')
      backupFile = `${fileName.replace(/^\./, '')}-${timestamp}.bak`
      const backupDirectory = path.join(process.env.MANAGER_ENV_BACKUP_DIR || 'C:\\web\\backups\\manager-env', projectId)
      await mkdir(backupDirectory, { recursive: true })
      await copyFile(filePath, path.join(backupDirectory, backupFile))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const previousManagedKeys = managedBlockKeys(current)
    const mergedContent = mergeEnv(current, values)
    await writeFile(filePath, mergedContent, 'utf8')
    const keys = Object.keys(values).sort()
    let configCacheCleared = false
    if (rows[0].project_type === 'laravel') {
      try {
        await unlink(path.join(rows[0].root_path, 'bootstrap', 'cache', 'config.php'))
        configCacheCleared = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    let restart = { attempted: false, success: false }
    if (body.restart !== false && /^[A-Za-z0-9._-]+$/.test(rows[0].pm2_name)) {
      restart.attempted = true
      const removedManagedKeys = [...previousManagedKeys].filter((key) => values[key] === undefined)
      const applicationEnv = {
        ...Object.fromEntries([...CONTROL_PLANE_KEYS, ...removedManagedKeys].map((key) => [key, ''])),
        ...parseEnv(mergedContent),
        ...projectRuntimeEnvironment(rows[0].runtime_versions),
        ...values,
      }
      const result = await runCommand(`pm2 restart "${rows[0].pm2_name}" --update-env`, rows[0].root_path, 60_000, undefined, applicationEnv, false)
      restart.success = result.code === 0
    }
    await audit(user?.id, 'project.data-service.sync-env', `project:${projectId}`, { file: fileName, keys, backupFile, configCacheCleared, restart })
    return NextResponse.json({ ok: true, ...preview, keys, backupFile, configCacheCleared, restart })
  } catch (error) {
    return jsonError(error)
  }
}
