import { lstat, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { runCommand } from '@/lib/exec'
import { audit } from '@/lib/audit'
import { maintenance, updateProtected } from '@/lib/update-maintenance'
import { planReleaseRetention, removeRetentionEntry, RETENTION, type ReleaseApp, type RetainedDeployment, type RetentionPlan } from '@/lib/release-retention'

let schema: Promise<void> | undefined
export function ensureReleaseCleanupSchema() {
  return schema ??= query(`create table if not exists manager_release_cleanup_settings (
    singleton boolean primary key default true check(singleton), enabled boolean not null default false);
    insert into manager_release_cleanup_settings(singleton) values(true) on conflict do nothing;
    create table if not exists manager_release_cleanup_runs (
      id uuid primary key default gen_random_uuid(), mode text not null, source text not null, user_id uuid,
      status text not null, started_at timestamptz not null default now(), finished_at timestamptz,
      report jsonb not null default '{}');`).then(() => {}).catch(error => { schema = undefined; throw error })
}

export interface CleanupReport {
  progress: string; projects: RetentionPlan[]; removed: { path: string; bytes: number; partial?: boolean }[]; warnings: string[]
  eligibleBytes: number; retainedBytes: number; removedBytes: number
}

// Process environments are inspected only in memory, never included in API responses or audit logs.
export function processReferences(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(p => p && typeof p === 'object' && typeof p.name === 'string' && p.pm2_env && typeof p.pm2_env === 'object')) throw Error('Process inspection unavailable; no release files were removed')
  const result: string[] = []
  const visit = (item: unknown, depth: number) => {
    if (depth > 10) throw Error('Process inspection exceeded safe limits')
    if (typeof item === 'string') result.push(item)
    else if (item && typeof item === 'object') for (const v of Object.values(item)) visit(v, depth + 1)
  }
  for (const item of value) visit(item.pm2_env, 0)
  return result
}

async function references() {
  const pm2 = await runCommand('pm2 jlist', undefined, 30000, undefined, undefined, false)
  if (pm2.code) throw Error('Process inspection unavailable; no release files were removed')
  let parsed: unknown
  try { parsed = JSON.parse(pm2.output) } catch { throw Error('Process inspection unavailable; no release files were removed') }
  const jobs = await query<{ command: string; working_directory: string }>('select command,working_directory from cron_jobs')
  const roots = await query<{ root_path: string }>('select root_path from projects')
  return [...processReferences(parsed), ...jobs.rows.flatMap(job => [job.command, job.working_directory]), ...roots.rows.map(app => app.root_path), process.cwd()]
}

export async function cleanupStatus() {
  await ensureReleaseCleanupSchema()
  const [settings, history, apps] = await Promise.all([
    query<{ enabled: boolean }>('select enabled from manager_release_cleanup_settings where singleton=true'),
    query('select id,mode,source,status,started_at,finished_at,report from manager_release_cleanup_runs order by started_at desc limit 10'),
    query<{ root_path: string }>('select root_path from projects'),
  ])
  const locations = await Promise.all([...new Set([process.cwd(), ...apps.rows.map(a => path.dirname(a.root_path))])].map(async root => {
    try { const [value, metadata] = await Promise.all([statfs(root), stat(root)]); return { path: root, device: String(metadata.dev), free: value.bavail * value.bsize, total: value.blocks * value.bsize } }
    catch { return { path: root, device: root, free: null, total: null } }
  }))
  const volumes = new Map<string, { path: string; locations: string[]; free: number | null; total: number | null }>()
  for (const location of locations) {
    const existing = volumes.get(location.device)
    if (existing) existing.locations.push(location.path)
    else volumes.set(location.device, { path: location.path, locations: [location.path], free: location.free, total: location.total })
  }
  const latestReport = history.rows.find(run => run.status !== 'running' && run.report.projects)?.id
  return { enabled: settings.rows[0].enabled, retention: RETENTION,
    history: history.rows.map(run => run.id === latestReport ? run : { ...run, report: { progress: run.report.progress, removedBytes: run.report.removedBytes } }), volumes: [...volumes.values()] }
}

export async function setCleanupEnabled(enabled: unknown, userId: string) {
  if (typeof enabled !== 'boolean') throw new ApiError('Choose whether automatic cleanup is enabled', 400)
  await ensureReleaseCleanupSchema()
  await query('update manager_release_cleanup_settings set enabled=$1 where singleton=true', [enabled])
  await audit(userId, 'release_cleanup.settings', 'manager', { enabled })
}

/** One DB session owns both the global sweep and each app's admission lock until its work ends. */
export async function startReleaseCleanup(mode: 'scan' | 'clean', source: 'manual' | 'scheduled', userId?: string) {
  if (maintenance() || process.env.MANAGER_PREVIEW === '1') throw new ApiError('Cleanup waits until Manager maintenance finishes', 503)
  await ensureReleaseCleanupSchema()
  const client = await db.connect()
  let lost = false
  let locked = false
  let handedOff = false
  const onError = () => { lost = true }
  client.on('error', onError)
  const check = () => { if (lost) throw Error('Cleanup lock was lost; removal stopped') }
  const release = async () => {
    try { if (locked && !lost) await client.query('select pg_advisory_unlock_all()') }
    catch { lost = true }
    finally { client.removeListener('error', onError); client.release(lost) }
  }
  try {
    locked = (await client.query("select pg_try_advisory_lock(hashtext('manager-release-cleanup')) as locked")).rows[0].locked
    if (!locked) { if (source === 'scheduled') return null; throw new ApiError('A storage scan or cleanup is already running', 409) }
    await client.query("update manager_release_cleanup_runs set status='interrupted',finished_at=now() where status='running'")
    if (source === 'scheduled') {
      const due = await client.query(`select enabled and not exists(select 1 from manager_release_cleanup_runs where source='scheduled' and started_at>now()-interval '24 hours') as due from manager_release_cleanup_settings where singleton=true`)
      if (!due.rows[0].due) return null
    }
    check()
    const row = await client.query<{ id: string }>("insert into manager_release_cleanup_runs(mode,source,user_id,status) values($1,$2,$3,'running') returning id", [mode, source, userId || null])
    const id = row.rows[0].id
    const run = async () => {
      const report: CleanupReport = { progress: 'Inspecting release workspaces', projects: [], removed: [], warnings: [], eligibleBytes: 0, retainedBytes: 0, removedBytes: 0 }
      const deadline = Date.now() + 30 * 60000
      const verify = () => { check(); if (Date.now() > deadline) throw Error('Cleanup time limit reached; remaining work is deferred') }
      const persist = () => client.query('update manager_release_cleanup_runs set report=$1 where id=$2', [JSON.stringify(report), id])
      try {
        await updateProtected('Release storage ' + mode, async () => {
          const apps = (await client.query<ReleaseApp>('select id,name,root_path,active_deployment_id from projects order by id')).rows
          for (const app of apps) {
            verify()
            const directory = path.join(path.dirname(app.root_path), '.manager-releases', app.id)
            if (!await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error })) continue
            report.progress = `Inspecting ${app.name}`; await persist()
            const acquired = (await client.query("select pg_try_advisory_lock(hashtext('manager-project'),hashtext($1)) as locked", [app.id])).rows[0].locked
            if (!acquired) { report.warnings.push(`${app.name}: another application operation is running`); continue }
            try {
              const active = await client.query("select id from deployments where project_id=$1 and status in ('queued','running') limit 1", [app.id])
              if (active.rows.length) { report.warnings.push(`${app.name}: deployment in progress`); continue }
              const current = (await client.query<ReleaseApp>('select id,name,root_path,active_deployment_id from projects where id=$1', [app.id])).rows[0]
              if (!current || current.root_path !== app.root_path) { report.warnings.push(`${app.name}: application location changed`); continue }
              const deployments = (await client.query<RetainedDeployment>('select id,status,phase,finished_at,release_path from deployments where project_id=$1', [app.id])).rows
              const plan = await planReleaseRetention(current, deployments, await references(), Date.now(), verify)
              report.projects.push(plan)
              report.eligibleBytes += plan.entries.filter(e => e.eligible).reduce((n, e) => n + e.bytes, 0)
              report.retainedBytes += plan.entries.filter(e => !e.eligible).reduce((n, e) => n + e.bytes, 0)
              if (mode === 'clean') for (const entry of plan.entries.filter(e => e.eligible)) {
                verify()
                await client.query('select 1')
                // Never accept file paths or eligibility supplied by the browser or an older scan.
                const fresh = await planReleaseRetention(current, deployments, await references(), Date.now(), verify, false)
                const target = fresh.entries.find(e => e.path === entry.path && e.eligible)
                if (!target || fresh.warnings.length) { report.warnings.push(`${app.name}: ${entry.name} became protected`); continue }
                report.progress = `Removing expired ${entry.kind} for ${app.name}`; await persist()
                try {
                  const bytes = await removeRetentionEntry(fresh, target, verify)
                  report.removed.push({ path: entry.path, bytes }); report.removedBytes += bytes
                } catch (error) {
                  const partial = error as Error & { removedBytes?: number }
                  if (partial.removedBytes) { report.removed.push({ path: entry.path, bytes: partial.removedBytes, partial: true }); report.removedBytes += partial.removedBytes }
                  throw error
                }
                await persist()
              }
            } catch (error) {
              check()
              report.warnings.push(`${app.name}: ${(error as Error).message}`)
            } finally { if (!lost) await client.query("select pg_advisory_unlock(hashtext('manager-project'),hashtext($1))", [app.id]) }
          }
          report.progress = mode === 'scan' ? 'Scan complete' : 'Cleanup complete'
          await client.query("update manager_release_cleanup_runs set status=$1,finished_at=now(),report=$2 where id=$3", [report.warnings.length || report.projects.some(p => p.warnings.length) ? 'completed_with_warnings' : 'completed', JSON.stringify(report), id])
          await client.query("delete from manager_release_cleanup_runs where finished_at<now()-interval '90 days' and id not in (select id from manager_release_cleanup_runs order by started_at desc limit 50)")
          await audit(userId, 'release_cleanup.' + mode, id, { source, removedEntries: report.removed.length, removedBytes: report.removedBytes, warnings: report.warnings.length })
        })
      } catch (error) {
        report.progress = 'Stopped'; report.warnings.push((error as Error).message)
        await query("update manager_release_cleanup_runs set status='failed',finished_at=now(),report=$1 where id=$2", [JSON.stringify(report), id]).catch(() => {})
      } finally { await release() }
    }
    handedOff = true
    void run().catch(error => console.error('[cleanup] Release storage operation failed:', error))
    return { id }
  } finally { if (!handedOff) await release() }
}

export async function releaseCleanupTick() { return startReleaseCleanup('clean', 'scheduled') }
