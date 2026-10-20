import { createHash, randomUUID } from 'crypto'
import { realpath } from 'fs/promises'
import path from 'path'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { managerRoot, managerScript } from '@/lib/paths'
import { acquireProjectOperation } from '@/lib/project-operation'
import { readServerHealth } from '@/lib/server-health'
import { applicationHealthProfile } from '@/lib/health-profiles'
import { runCommand } from '@/lib/exec'
import { recoveryBlockers, assertReviewTicket } from '@/lib/ai-operations-policy'
import { aiSettings, ensureAiSchema } from '@/lib/ai-operations-store'
import { configurationIdentity } from '@/lib/ai-operations-config'
import { probeHttp } from '../scripts/http-health.cjs'

interface ProcessIdentity { id: number; name: string; pid: number; status: string; restarts: number; cwd: string; port: number }
async function processes(): Promise<ProcessIdentity[]> {
  const result = await runCommand({ file: process.execPath, args: [managerScript('operations-pm2.cjs'), 'inventory'] }, undefined, 10000)
  if (result.code !== 0) throw new ApiError('PM2 is unavailable. No recovery action was run.', 409)
  try {
    const rows = JSON.parse(result.output)
    if (!Array.isArray(rows)) throw Error()
    return rows
  } catch { throw new ApiError('PM2 process identity could not be verified.', 409) }
}
async function context(projectId: string) {
  const project = (await query('select id,name,root_path,pm2_name,port,updated_at,is_active from projects where id=$1', [projectId])).rows[0]
  if (!project || !project.is_active) throw new ApiError('Active application not found', 404)
  const health = await readServerHealth()
  const root = await realpath(project.root_path)
  const ownRoot = await realpath(managerRoot())
  const blockers = recoveryBlockers(health, project.pm2_name, root.toLowerCase() === ownRoot.toLowerCase() || project.pm2_name === 'manager')
  const settings = await aiSettings()
  if (!settings.recoveryEnabled) blockers.push('Reviewed recovery is paused by an administrator.')
  if (!Number.isInteger(project.port) || project.port < 1 || project.port > 65535) blockers.push('A valid application readiness port is required.')
  if (blockers.length) throw new ApiError(blockers.join(' '), 409)
  const all = await processes(), matches = all.filter(p => p.name === project.pm2_name)
  const target = matches[0]
  if (matches.length !== 1 || !Number.isInteger(target?.id) || target.id < 0 || !['online', 'errored'].includes(target.status) ||
      path.resolve(target.cwd || '').toLowerCase() !== root.toLowerCase() || target.port !== project.port ||
      all.some(p => p.id !== target.id && p.port === project.port)) throw new ApiError('Application process identity is ambiguous or changed.', 409)
  const assigned = await query('select id from projects where pm2_name=$1 or port=$2', [project.pm2_name, project.port])
  if (assigned.rows.length !== 1 || assigned.rows[0].id !== projectId) throw new ApiError('Another project shares this process or port.', 409)
  const profile = await applicationHealthProfile(project.pm2_name)
  const lastDeployment = (await query('select id,status from deployments where project_id=$1 order by started_at desc nulls last limit 1', [projectId])).rows[0] || null
  const configuration = await configurationIdentity(root)
  const fingerprint = createHash('sha256').update(JSON.stringify({ project, target, profile, lastDeployment, configuration,
    incidents: health.incidents.filter(i => !i.resolvedAt && i.service === project.pm2_name).map(i => i.id).sort() })).digest('hex')
  return { project, target, all, profile, fingerprint }
}
async function assertIdle(projectId: string) {
  const active = await query(`select 1 from data_service_backup_schedules b join project_data_services s on s.id=b.service_id
    where s.project_id=$1 and b.last_status='running'
    union all select 1 from cron_jobs where (project_id=$1 or project_id is null) and last_status='running'
    union all select 1 from backup_schedules where last_status='running'
    union all select 1 from data_migration_jobs where status in ('queued','running','validating')
    union all select 1 from database_moves where status in ('queued','running','validating')
    union all select 1 from database_renames where status in ('queued','running','validating') limit 1`, [projectId])
  if (active.rowCount) throw new ApiError('A related job or database operation is active. Wait before recovery.', 409)
}
async function cooldown(projectId: string) {
  const recent = await query(`select 1 from manager_ai_events where project_id=$1 and kind='recovery' and created_at>now()-interval '30 minutes' limit 1`, [projectId])
  if (recent.rowCount) throw new ApiError('A recovery was already attempted recently. Review its result before retrying after 30 minutes.', 409)
}
export async function prepareRecovery(projectId: string, actor: string) {
  await ensureAiSchema()
  const release = await acquireProjectOperation(projectId)
  try {
    await assertIdle(projectId); await cooldown(projectId)
    const current = await context(projectId)
    const id = randomUUID()
    const result = await query(`insert into manager_ai_reviews(id,actor_id,project_id,fingerprint,expires_at)
      values($1,$2,$3,$4,now()+interval '5 minutes') returning expires_at`, [id, actor, projectId, current.fingerprint])
    return { id, projectId, projectName: current.project.name, expiresAt: result.rows[0].expires_at,
      action: 'Restart this application once using its existing PM2 configuration.',
      impact: 'Active requests to this application may be interrupted while it restarts. The release and environment are unchanged.',
      verification: 'Two consecutive readiness checks and an unchanged inventory of other processes are required.',
      rollback: 'A restart cannot be undone. Failure stops further attempts and records an incident for review.' }
  } finally { await release() }
}
export async function cancelRecovery(id: string, actor: string) {
  await query(`update manager_ai_reviews set status='cancelled' where id=$1 and actor_id=$2 and status='pending'`, [id, actor])
  return { cancelled: true }
}
export async function executeRecovery(id: string, actor: string) {
  if (process.env.MANAGER_PREVIEW === '1') throw new ApiError('Preview is read-only', 503)
  const ticket = (await query<{ actor_id: string; project_id: string; status: string; expires_at: Date; fingerprint: string }>('select * from manager_ai_reviews where id=$1', [id])).rows[0]
  if (!ticket) throw new ApiError('Recovery review not found', 404)
  const gate = await db.connect()
  let locked = false, release: undefined | (() => Promise<void>), claimed = false
  const event = randomUUID()
  try {
    locked = (await gate.query("select pg_try_advisory_lock(hashtext('manager-ai-recovery'),0) as locked")).rows[0].locked
    if (!locked) throw new ApiError('Another reviewed recovery is running', 409)
    release = await acquireProjectOperation(ticket.project_id)
    await assertIdle(ticket.project_id); await cooldown(ticket.project_id)
    const current = await context(ticket.project_id)
    try { assertReviewTicket(ticket, actor, current.fingerprint) } catch (error) { throw new ApiError((error as Error).message, 409) }
    // An incident may have recovered between monitor samples. Probe again before
    // approving any restart, and never restart a database configuration failure.
    let probe
    try { probe = await probeHttp(`http://127.0.0.1:${current.project.port}${current.profile.path}`, { statuses: current.profile.statuses, diagnostics: true, signal: AbortSignal.timeout(5000) }) }
    catch { probe = { ok: false } }
    if (probe.ok || probe.diagnostics?.issueCode?.startsWith('database')) throw new ApiError('Fresh readiness changed or identifies a database issue. No restart was performed.', 409)
    const rechecked = await context(ticket.project_id)
    if (rechecked.fingerprint !== current.fingerprint) throw new ApiError('Application state changed during review. No restart was performed.', 409)
    // Persist both the claim and audit entry before any process mutation.
    await gate.query('begin')
    const claim = await gate.query("update manager_ai_reviews set status='running' where id=$1 and status='pending' and expires_at>now() returning id", [id])
    if (!claim.rowCount) { await gate.query('rollback'); throw new ApiError('This review is no longer available', 409) }
    await gate.query(`insert into manager_ai_events(id,kind,actor_id,project_id,status,details) values($1,'recovery',$2,$3,'running',$4)`, [event, actor, ticket.project_id, JSON.stringify({ reviewId: id, action: 'restart', service: current.target.name })])
    await gate.query('commit'); claimed = true
    const restart = await runCommand({ file: process.execPath, args: [managerScript('operations-pm2.cjs'), 'restart', String(current.target.id)] }, current.project.root_path, 30000)
    let healthy = false
    if (restart.code === 0) {
      const deadline = Date.now() + Math.min(current.profile.timeoutMs, 60000)
      let passed = 0
      while (Date.now() < deadline) {
        try {
          const result = await probeHttp(`http://127.0.0.1:${current.project.port}${current.profile.path}`, { statuses: current.profile.statuses, signal: AbortSignal.timeout(5000) })
          passed = result.ok ? passed + 1 : 0
          if (passed >= 2) { healthy = true; break }
        } catch { passed = 0 }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    const after = await processes()
    const unchanged = current.all.filter(p => p.id !== current.target.id).every(p => after.some(a => a.id === p.id && a.name === p.name && a.pid === p.pid && a.status === p.status && a.restarts === p.restarts))
      && after.length === current.all.length
    const target = after.find(p => p.id === current.target.id)
    healthy = healthy && target?.status === 'online' && target.name === current.target.name
    const status = healthy && unchanged ? 'succeeded' : 'failed'
    const result = { healthy, otherProcessesUnchanged: unchanged, service: current.target.name, reviewId: id,
      message: status === 'succeeded' ? 'The application passed two readiness checks; other processes are unchanged.' : 'Recovery needs review. No further automatic action will run.' }
    await query('update manager_ai_reviews set status=$2,result=$3 where id=$1', [id, status, JSON.stringify(result)])
    await query('update manager_ai_events set status=$2,details=$3 where id=$1', [event, status, JSON.stringify(result)])
    return { status, ...result }
  } catch (error) {
    await gate.query('rollback').catch(() => {})
    if (claimed) {
      const details = JSON.stringify({ reviewId: id, message: 'Recovery verification was interrupted. Inspect this application before another attempt.' })
      await query("update manager_ai_reviews set status='failed',result=$2 where id=$1", [id, details]).catch(() => {})
      await query("update manager_ai_events set status='failed',details=$2 where id=$1", [event, details]).catch(() => {})
    }
    if (error instanceof ApiError) throw error
    throw new ApiError('Recovery could not be completed. Inspect the operation history before retrying.', 500)
  } finally {
    try { if (release) await release() } finally {
      if (locked) { try { await gate.query("select pg_advisory_unlock(hashtext('manager-ai-recovery'),0)"); gate.release() } catch { gate.release(true) } }
      else gate.release()
    }
  }
}
