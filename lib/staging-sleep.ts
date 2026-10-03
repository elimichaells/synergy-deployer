import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { audit } from '@/lib/audit'
import { ApiError } from '@/lib/api'
import { appsToSleep, normalizeWakeHost } from '@/lib/staging-sleep-policy'

/**
 * Idle staging apps sleep to give their memory back, and wake when they are deployed, when
 * someone presses Wake, or when someone opens their address (Caddy sends the error for a stopped
 * app to the manager's wake page).
 */

interface StagingRow {
  id: string; name: string; environment: string | null; pm2_name: string; port: number | null
  sleep_after_minutes: number | null; sleeping_since: Date | null; last_active_at: Date | null
  last_deploy_at: Date | null; deploying: boolean
}

const iso = (value: Date | null) => value ? value.toISOString() : null

/** Runs after each memory sample: records use, notices apps woken elsewhere, and stops idle ones. */
export async function stagingSleepTick(runningApps: Set<string>, activePorts: Set<number> | null) {
  // Without connection data there is no way to tell an idle app from a busy one; do nothing.
  if (!activePorts) return
  const { rows } = await query<StagingRow>(`
    select p.id, p.name, p.environment, p.pm2_name, p.port, p.sleep_after_minutes, p.sleeping_since, p.last_active_at,
           (select max(coalesce(d.finished_at, d.started_at)) from deployments d where d.project_id = p.id) as last_deploy_at,
           exists (select 1 from deployments d where d.project_id = p.id and d.status in ('queued','running')) as deploying
    from projects p where p.environment = 'staging' and p.sleep_after_minutes is not null`)
  const now = Date.now()
  for (const row of rows) {
    const running = runningApps.has(row.pm2_name)
    if (running && row.port && activePorts.has(row.port)) {
      await query('update projects set last_active_at = now() where id = $1', [row.id])
      row.last_active_at = new Date(now)
    }
    if (running && row.sleeping_since) {
      // Started by a deployment or by hand since it went to sleep.
      await query('update projects set sleeping_since = null, last_active_at = now() where id = $1', [row.id])
      row.sleeping_since = null
      row.last_active_at = new Date(now)
    }
  }
  const idle = appsToSleep(rows.map(row => ({
    projectId: row.id, environment: row.environment, sleepAfterMinutes: row.sleep_after_minutes, running: runningApps.has(row.pm2_name),
    sleepingSince: iso(row.sleeping_since), lastActiveAt: iso(row.last_active_at), lastDeployAt: iso(row.last_deploy_at), deploying: row.deploying,
  })), now)
  for (const candidate of idle) {
    const row = rows.find(item => item.id === candidate.projectId)!
    if (!/^[A-Za-z0-9._-]+$/.test(row.pm2_name)) continue
    const stopped = await runCommand(`pm2 stop "${row.pm2_name}"`, undefined, 60_000)
    if (stopped.code) { console.error(`[sleep] could not stop ${row.name}`); continue }
    await query('update projects set sleeping_since = now() where id = $1', [row.id])
    await audit(null, 'project.slept', `project:${row.id}`, { idleMinutes: row.sleep_after_minutes })
    console.log(`[sleep] ${row.name} is asleep after ${row.sleep_after_minutes} idle minutes`)
  }
}

const wakes = new Map<string, number>()
const WAKE_COOLDOWN_MS = 90_000

/** Starts a sleeping app in the background. Repeated calls within a minute and a half do nothing more. */
export function wakeStagingApp(projectId: string, actor: string | null, source: 'button' | 'visit' | 'setting') {
  const last = wakes.get(projectId)
  if (last && Date.now() - last < WAKE_COOLDOWN_MS) return 'starting' as const
  wakes.set(projectId, Date.now())
  void (async () => {
    try {
      const { restartWithFreshEnvironment } = await import('@/lib/deploy')
      const result = await restartWithFreshEnvironment(projectId)
      if (result.healthy) await query('update projects set sleeping_since = null, last_active_at = now() where id = $1', [projectId])
      await audit(actor, 'project.woken', `project:${projectId}`, { source, healthy: result.healthy, reason: result.reason })
      if (!result.healthy) console.error(`[sleep] waking ${projectId} failed: ${result.reason}`)
    } catch (error) {
      console.error('[sleep] wake failed:', error instanceof Error ? error.message : error)
    } finally {
      // Let a later visit try again if this attempt failed quickly.
      setTimeout(() => wakes.delete(projectId), WAKE_COOLDOWN_MS)
    }
  })()
  return 'starting' as const
}

const hostCache = new Map<string, { projectId: string | null; at: number }>()

/** For the public wake page: wakes the staging app behind a host name, if it is one that sleeps. */
export async function wakeByHost(value: unknown): Promise<'starting' | 'unknown'> {
  const host = normalizeWakeHost(value)
  if (!host) return 'unknown'
  let cached = hostCache.get(host)
  if (!cached || Date.now() - cached.at > 60_000) {
    const { rows } = await query<{ id: string }>(`
      select p.id from projects p
      where p.environment = 'staging' and p.sleep_after_minutes is not null
        and (lower(regexp_replace(coalesce(p.url, ''), '^https?://([^/:]+).*$', '\\1')) = $1
             or exists (select 1 from project_domains d where d.project_id = p.id and lower(d.hostname) = $1))
      limit 1`, [host]).catch(() => ({ rows: [] as { id: string }[] }))
    cached = { projectId: rows[0]?.id ?? null, at: Date.now() }
    hostCache.set(host, cached)
  }
  if (!cached.projectId) return 'unknown'
  return wakeStagingApp(cached.projectId, null, 'visit')
}

/** The host names Caddy serves for an app. */
async function appHosts(projectId: string) {
  const { rows } = await query<{ host: string }>(`
    select lower(regexp_replace(url, '^https?://([^/:]+).*$', '\\1')) as host from projects where id = $1 and url ~* '^https?://'
    union select lower(hostname) from project_domains where project_id = $1`, [projectId])
  return [...new Set(rows.map(row => row.host).filter(Boolean))]
}

/** Turns sleeping on or off for a staging app and updates its Caddy site so visits can wake it. */
export async function setStagingSleep(projectId: string, minutes: number | null, userId: string | null | undefined) {
  const { rows } = await query<{ environment: string | null; port: number | null; sleep_after_minutes: number | null; sleeping_since: Date | null }>(
    'select environment, port, sleep_after_minutes, sleeping_since from projects where id = $1', [projectId])
  const app = rows[0]
  if (!app) throw new ApiError('Application not found', 404)
  if (app.environment !== 'staging') throw new ApiError('Only staging apps can sleep. Production apps always stay running.', 400)
  await query('update projects set sleep_after_minutes = $2, last_active_at = now() where id = $1', [projectId, minutes])
  hostCache.clear()
  await audit(userId, 'project.sleep_changed', `project:${projectId}`, { from: app.sleep_after_minutes, to: minutes })

  // Caddy needs the wake handler only while sleeping is on.
  let caddy: string | null = null
  if (app.port && (minutes === null) !== (app.sleep_after_minutes === null)) {
    try {
      const { refreshCaddyHosts } = await import('@/lib/caddy')
      await refreshCaddyHosts(await appHosts(projectId), app.port)
    } catch (error) {
      caddy = 'The web server could not be updated, so opening the app will not wake it yet: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error))
    }
  }
  if (minutes === null && app.sleeping_since) wakeStagingApp(projectId, userId ?? null, 'setting')
  return { caddyWarning: caddy }
}
