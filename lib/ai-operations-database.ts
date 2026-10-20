import { lstat, readFile, realpath } from 'fs/promises'
import path from 'path'
import { parse } from 'dotenv'
import { query } from '@/lib/db'
import { ApiError } from '@/lib/api'

export async function databaseConfigurationReview(projectId: string) {
  const project = (await query('select id,name,project_type,root_path from projects where id=$1', [projectId])).rows[0]
  if (!project) throw new ApiError('Application not found', 404)
  const services = (await query(`select s.id,s.name,s.application_primary,s.options,dc.provider,
    (s.password_ciphertext is not null) as has_secret
    from project_data_services s join data_connections dc on dc.id=s.connection_id where s.project_id=$1`, [projectId])).rows
  const root = await realpath(project.root_path)
  const files: { file: string; present: string[]; empty: string[] }[] = []
  const effective: Record<string, string> = {}
  const warnings: string[] = []
  // Inspect only regular configuration files within this application's actual root.
  for (const file of ['.env', '.env.production', '.env.local', '.env.production.local']) {
    const target = path.join(root, file)
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256000 || path.dirname(await realpath(target)).toLowerCase() !== root.toLowerCase()) {
        warnings.push(`${file} cannot be inspected safely.`); continue
      }
      const values = parse(await readFile(target, 'utf8'))
      const keys = Object.keys(values).filter(key => /^(?:DATABASE_|DB_|PGHOST$|PGPORT$|PGUSER$|PGPASSWORD$|PGDATABASE$|MONGODB_URI$|REDIS_URL$)/.test(key))
      files.push({ file, present: keys.filter(k => values[k].trim()).sort(), empty: keys.filter(k => !values[k].trim()).sort() })
      for (const key of keys) effective[key] = values[key]
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${file} could not be inspected.`) }
  }
  const primary = services.filter(s => s.application_primary)
  const hasUrl = ['DATABASE_URL', 'DB_URL', 'MONGODB_URI'].some(key => !!effective[key]?.trim())
  const split = project.project_type === 'laravel' ? ['DB_HOST', 'DB_DATABASE', 'DB_USERNAME'] :
    project.project_type === 'go' ? ['DB_HOST', 'DB_NAME', 'DB_USER'] : ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER']
  const missing = hasUrl ? [] : split.filter(key => !effective[key]?.trim())
  if (!primary.length) warnings.push('No primary managed database is assigned. Existing application or runtime configuration may still provide a database.')
  if (primary.length > 1) warnings.push('Multiple primary services were found. Resolve the assignment before syncing any configuration.')
  if (primary.some(s => s.options?.ownership === 'adopted')) warnings.push('The primary database was adopted from existing configuration; Manager must not overwrite its credentials.')
  if (missing.length) warnings.push('Common database settings are incomplete on disk. Confirm this app’s actual variable names and runtime environment before changing them.')
  return { projectId, projectName: project.name, projectType: project.project_type, files, missing,
    services: services.map(s => ({ id: s.id, name: s.name, provider: s.provider, primary: s.application_primary, hasStoredCredential: s.has_secret, adopted: s.options?.ownership === 'adopted' })),
    warnings, nextSteps: [
      'Confirm the intended database and least-privileged application account in this app’s Storage tab.',
      'If managed credentials already exist, use Preview environment sync to review the affected keys before applying any change.',
      'Test the application database connection and readiness after an approved configuration change.',
    ],
    limitations: 'This review inspects files and service assignments only. It does not expose values, validate passwords, inspect PM2 secrets, create accounts, or change configuration.',
    href: '/sites/' + projectId + '?tab=storage' }
}
