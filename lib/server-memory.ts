import os from 'os'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { sendNotification } from '@/lib/notify'
import { buildLimit, buildMemoryFloorMb } from '@/lib/deployment-capacity'
import { attributeMemory, downsample, evaluateMemory, lowMemoryThreshold, type AlertCondition, type MemorySample, type ProcessRow } from '@/lib/server-memory-policy'
import { engineFromServicePath } from '@/lib/database-tuning-policy'

const MB = 1024 * 1024

export interface AppUsage {
  name: string
  projectId: string | null
  label: string
  environment: string | null
  privateMb: number
  workingMb: number
  processes: number
  limitMb: number | null
  /** Memory used by processes that only start the app. */
  overheadMb: number
  /** Started through the manager's runner rather than directly by PM2. */
  runner: boolean
}

export interface MemorySnapshot {
  takenAt: string
  platform: NodeJS.Platform
  totalMb: number
  availableMb: number
  commitMb: number | null
  commitLimitMb: number | null
  pageFileMb: number | null
  pageFileUsedMb: number | null
  apps: AppUsage[]
  others: { name: string; count: number; privateMb: number }[]
  /** Local ports with an open inbound connection; null where this cannot be read. */
  activePorts: number[] | null
  /** Database servers running as services on this machine. */
  databases: DatabaseUsage[]
}

export interface DatabaseUsage { service: string; engine: string; privateMb: number; processes: number; ports: number[] }

const DB_PREFIX = 'service:'

// One CIM query gives every process with its parent, private bytes and start time.
const WINDOWS_SNAPSHOT = [
  "$ErrorActionPreference = 'Stop'",
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$pf = @(Get-CimInstance Win32_PageFileUsage)',
  "$epoch = [datetime]'1970-01-01'",
  // Command lines stay inside PowerShell (they can hold secrets); only a launcher flag leaves it.
  '$p = @(Get-CimInstance Win32_Process | ForEach-Object { ,@([int64]$_.ProcessId, [int64]$_.ParentProcessId, [string]$_.Name, [int64]$_.PrivatePageCount, [int64]$_.WorkingSetSize, $(if ($_.CreationDate) { [int64]($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds } else { 0 }), [bool]([string]$_.CommandLine -match "pm2-runner\.js|npm-cli\.js|[\\/]cross-env[\\/]")) })',
  // Ports with an open inbound connection show which apps are in use (for sleeping staging apps).
  '$ports = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)',
  // Database servers run as Windows services; their process trees and listening ports identify them.
  '$svc = @(Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -and $_.PathName -match "mysqld|mariadbd|pg_ctl|postgres|memurai|redis-server|mongod" } | ForEach-Object { ,@([int64]$_.ProcessId, [string]$_.Name, [string]$_.PathName) })',
  '$listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { ,@([int]$_.LocalPort, [int64]$_.OwningProcess) })',
  "[pscustomobject]@{ services = $svc; listen = $listen; ports = $ports; totalKb = [int64]$os.TotalVisibleMemorySize; freeKb = [int64]$os.FreePhysicalMemory; commitLimitKb = [int64]$os.TotalVirtualMemorySize; commitFreeKb = [int64]$os.FreeVirtualMemory; pageFileMb = [int64](($pf | Measure-Object AllocatedBaseSize -Sum).Sum); pageFileUsedMb = [int64](($pf | Measure-Object CurrentUsage -Sum).Sum); p = $p } | ConvertTo-Json -Compress -Depth 4",
].join('; ')

interface RawHost {
  totalMb: number; availableMb: number; commitMb: number | null; commitLimitMb: number | null; pageFileMb: number | null; pageFileUsedMb: number | null
  processes: ProcessRow[]; activePorts: number[] | null
  services: { pid: number; name: string; engine: string }[]
  listeners: { port: number; pid: number }[]
}

const pairs = (value: unknown): unknown[][] => Array.isArray(value) ? (value.length && !Array.isArray(value[0]) ? [value] : value.filter(Array.isArray)) : []

async function readHost(): Promise<RawHost> {
  if (process.platform === 'win32') {
    const result = await runCommand({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SNAPSHOT] }, undefined, 45_000, undefined, undefined, true)
    if (result.code) throw new Error('Could not read memory from Windows')
    const raw = JSON.parse(result.output.slice(result.output.indexOf('{')))
    const rows: unknown[][] = Array.isArray(raw.p) ? raw.p : []
    return {
      totalMb: Math.round(raw.totalKb / 1024), availableMb: Math.round(raw.freeKb / 1024),
      commitLimitMb: Math.round(raw.commitLimitKb / 1024), commitMb: Math.round((raw.commitLimitKb - raw.commitFreeKb) / 1024),
      pageFileMb: raw.pageFileMb ?? null, pageFileUsedMb: raw.pageFileUsedMb ?? null,
      activePorts: Array.isArray(raw.ports) ? raw.ports.map(Number) : typeof raw.ports === 'number' ? [raw.ports] : [],
      services: pairs(raw.services).map(row => ({ pid: Number(row[0]), name: String(row[1]), engine: engineFromServicePath(String(row[2])) || 'database' })),
      listeners: pairs(raw.listen).map(row => ({ port: Number(row[0]), pid: Number(row[1]) })),
      processes: rows.filter(row => Array.isArray(row) && row.length >= 6).map(row => ({
        pid: Number(row[0]), ppid: Number(row[1]), name: String(row[2]), privateBytes: Number(row[3]) || 0, workingBytes: Number(row[4]) || 0, started: Number(row[5]) || undefined, launcher: row[6] === true })),
    }
  }
  // Elsewhere, resident memory stands in for private memory.
  const result = await runCommand({ file: 'ps', args: ['-A', '-o', 'pid=,ppid=,rss=,comm='] }, undefined, 30_000, undefined, undefined, true)
  const processes = result.code ? [] : result.output.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match![1]), ppid: Number(match![2]), name: match![4].trim().split('/').pop()!, privateBytes: Number(match![3]) * 1024, workingBytes: Number(match![3]) * 1024 }))
  return { totalMb: Math.round(os.totalmem() / MB), availableMb: Math.round(os.freemem() / MB), commitMb: null, commitLimitMb: null, pageFileMb: null, pageFileUsedMb: null, processes, activePorts: null, services: [], listeners: [] }
}

async function readPm2Roots() {
  const result = await runCommand('pm2 jlist', undefined, 30_000)
  const roots = new Map<number, string>()
  // PM2's container for an app started through the manager's runner only launches the app.
  const runners = new Set<number>()
  if (result.code) return { roots, runners }
  try {
    for (const item of JSON.parse(result.output.slice(result.output.indexOf('['))) as { name: string; pid?: number; pm2_env?: { pm_exec_path?: string } }[]) {
      if (!item.pid) continue
      roots.set(item.pid, item.name)
      if (/pm2-runner\.js$/i.test(item.pm2_env?.pm_exec_path || '')) runners.add(item.pid)
    }
  } catch { /* An unreadable list leaves every process unattributed rather than failing the snapshot. */ }
  return { roots, runners }
}

export async function readMemorySnapshot(): Promise<MemorySnapshot> {
  const [host, { roots, runners }] = await Promise.all([readHost(), readPm2Roots()])
  // Database services are attributed like apps, under a name PM2 can never use.
  const allRoots = new Map(roots)
  for (const service of host.services) allRoots.set(service.pid, `${DB_PREFIX}${service.name}`)
  const attributed = attributeMemory(host.processes.map(row => runners.has(row.pid) ? { ...row, launcher: true } : row), allRoots)
  const apps = attributed.apps.filter(app => !app.name.startsWith(DB_PREFIX))
  const others = attributed.others
  const runnerNames = new Set([...runners].map(pid => roots.get(pid)))
  const databases: DatabaseUsage[] = host.services.map(service => {
    const usage = attributed.apps.find(app => app.name === `${DB_PREFIX}${service.name}`)
    const ports = [...new Set(host.listeners.filter(listener => attributed.ownerOf(listener.pid) === `${DB_PREFIX}${service.name}`).map(listener => listener.port))].sort((a, b) => a - b)
    return { service: service.name, engine: service.engine, privateMb: usage?.privateMb ?? 0, processes: usage?.processes ?? 0, ports }
  }).sort((a, b) => b.privateMb - a.privateMb)
  await ensureServerMemorySchema()
  const { rows: projects } = await query<{ id: string; name: string; environment: string | null; pm2_name: string; memory_limit_mb: number | null }>(
    'select id, name, environment, pm2_name, memory_limit_mb from projects')
  const byPm2 = new Map(projects.map(project => [project.pm2_name, project]))
  return {
    takenAt: new Date().toISOString(), platform: process.platform,
    totalMb: host.totalMb, availableMb: host.availableMb, commitMb: host.commitMb, commitLimitMb: host.commitLimitMb,
    pageFileMb: host.pageFileMb, pageFileUsedMb: host.pageFileUsedMb, activePorts: host.activePorts,
    apps: apps.map(app => {
      const project = byPm2.get(app.name)
      return { ...app, runner: runnerNames.has(app.name), projectId: project?.id ?? null, label: project?.name ?? app.name, environment: project?.environment ?? null, limitMb: project?.memory_limit_mb ?? null }
    }),
    others,
    databases,
  }
}

let schemaReady: Promise<void> | null = null
export function ensureServerMemorySchema() {
  schemaReady ??= query(`
    alter table projects add column if not exists memory_limit_mb integer;
    alter table projects add column if not exists start_method text;
    alter table projects add column if not exists sleep_after_minutes integer;
    alter table projects add column if not exists sleeping_since timestamptz;
    alter table projects add column if not exists last_active_at timestamptz;
    create table if not exists server_memory_samples (
      taken_at timestamptz primary key default now(),
      total_mb integer not null, available_mb integer not null,
      commit_mb integer, commit_limit_mb integer, page_file_mb integer, page_file_used_mb integer,
      apps jsonb not null default '[]'::jsonb
    );
    create table if not exists server_alerts (
      id uuid primary key default gen_random_uuid(),
      kind text not null, subject text not null, level text not null,
      message text not null, details jsonb not null default '{}'::jsonb,
      opened_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
      resolved_at timestamptz, notified_at timestamptz
    );
    create unique index if not exists server_alerts_one_open on server_alerts (kind, subject) where resolved_at is null;
  `).then(() => undefined).catch(error => { schemaReady = null; throw error })
  return schemaReady
}

// ─── Sampling and alerts ───────────────────────────────────────────────────────

const RETENTION_DAYS = 8
/** An alert closes once its condition has not been seen for this long, so it does not flap. */
const RESOLVE_AFTER_MS = 15 * 60_000

let latest: MemorySnapshot | null = null
let sampling = false
let lastPrune = 0

/** The newest snapshot if it is recent enough, otherwise a fresh one. */
export async function currentMemorySnapshot(maxAgeMs = 20_000) {
  if (latest && Date.now() - Date.parse(latest.takenAt) <= maxAgeMs) return latest
  latest = await readMemorySnapshot()
  return latest
}

export async function memorySamplerTick() {
  if (sampling) return
  sampling = true
  try {
    const snapshot = await readMemorySnapshot()
    latest = snapshot
    await query(`insert into server_memory_samples (taken_at, total_mb, available_mb, commit_mb, commit_limit_mb, page_file_mb, page_file_used_mb, apps)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (taken_at) do nothing`,
      [snapshot.takenAt, snapshot.totalMb, snapshot.availableMb, snapshot.commitMb, snapshot.commitLimitMb, snapshot.pageFileMb, snapshot.pageFileUsedMb,
        JSON.stringify(snapshot.apps.map(app => ({ name: app.name, privateMb: app.privateMb })))])
    if (Date.now() - lastPrune > 3600_000) {
      lastPrune = Date.now()
      await query(`delete from server_memory_samples where taken_at < now() - make_interval(days => $1)`, [RETENTION_DAYS])
      await query(`delete from server_alerts where resolved_at < now() - interval '30 days'`)
    }
    await updateAlerts(snapshot)
    const { stagingSleepTick } = await import('@/lib/staging-sleep')
    await stagingSleepTick(new Set(snapshot.apps.map(app => app.name)), snapshot.activePorts ? new Set(snapshot.activePorts) : null)
  } catch (error) {
    console.error('[memory] sample failed:', error instanceof Error ? error.message : error)
  } finally { sampling = false }
}

interface SampleRow { taken_at: Date; total_mb: number; available_mb: number; commit_mb: number | null; commit_limit_mb: number | null; apps: { name: string; privateMb: number }[] }
const toSample = (row: SampleRow): MemorySample => ({ takenAt: row.taken_at.toISOString(), totalMb: row.total_mb, availableMb: row.available_mb, commitMb: row.commit_mb, commitLimitMb: row.commit_limit_mb, apps: row.apps || [] })

async function updateAlerts(snapshot: MemorySnapshot) {
  // The last few samples, plus the ones from about six hours ago for the growth check.
  const { rows } = await query<SampleRow>(`
    (select taken_at, total_mb, available_mb, commit_mb, commit_limit_mb, apps from server_memory_samples order by taken_at desc limit 3)
    union
    (select taken_at, total_mb, available_mb, commit_mb, commit_limit_mb, apps from server_memory_samples
      where taken_at between now() - interval '390 minutes' and now() - interval '330 minutes')
    order by taken_at`)
  const limits = new Map(snapshot.apps.filter(app => app.limitMb).map(app => [app.name, app.limitMb!]))
  const labels = new Map(snapshot.apps.map(app => [app.name, app.label]))
  const conditions = evaluateMemory(rows.map(toSample), limits, labels)

  for (const condition of conditions) {
    const { rows: open } = await query<{ id: string; level: string; notified_at: Date | null }>(
      'select id, level, notified_at from server_alerts where kind=$1 and subject=$2 and resolved_at is null', [condition.kind, condition.subject])
    if (open[0]) {
      const escalated = open[0].level === 'warning' && condition.level === 'error'
      await query('update server_alerts set level=$2, message=$3, details=$4, last_seen_at=now() where id=$1', [open[0].id, condition.level, condition.message, JSON.stringify(condition.details)])
      if (escalated) await notify(open[0].id, condition, 'Got worse: ')
    } else {
      const { rows: created } = await query<{ id: string }>(
        `insert into server_alerts (kind, subject, level, message, details) values ($1,$2,$3,$4,$5)
         on conflict (kind, subject) where resolved_at is null do update set last_seen_at = now() returning id`,
        [condition.kind, condition.subject, condition.level, condition.message, JSON.stringify(condition.details)])
      if (created[0]) await notify(created[0].id, condition)
    }
  }

  const { rows: stale } = await query<{ id: string; kind: string; subject: string; message: string; notified_at: Date | null }>(
    `update server_alerts set resolved_at = now() where resolved_at is null and last_seen_at < now() - make_interval(secs => $1)
     returning id, kind, subject, message, notified_at`, [RESOLVE_AFTER_MS / 1000])
  for (const alert of stale) {
    if (alert.notified_at) await sendNotification('Memory back to normal', `Resolved: ${alert.message}`, 'success', [{ name: 'Server', value: os.hostname() }])
  }
}

async function notify(id: string, condition: AlertCondition, prefix = '') {
  const title = condition.kind === 'low_memory' ? 'Server memory is low' : condition.kind === 'commit_high' ? 'Server is close to its memory limit'
    : condition.kind === 'app_over_limit' ? 'App over its memory limit' : 'App memory keeps growing'
  const sent = await sendNotification(`${prefix}${title}`, condition.message, condition.level, [{ name: 'Server', value: os.hostname() }])
  if (sent) await query('update server_alerts set notified_at=now() where id=$1', [id])
}

// ─── Reading for the pages ─────────────────────────────────────────────────────

export interface MemoryAlert { id: string; kind: string; subject: string; level: string; message: string; opened_at: string; last_seen_at: string; resolved_at: string | null; notified: boolean }

export async function memoryOverview() {
  await ensureServerMemorySchema()
  const snapshot = await currentMemorySnapshot()
  const [history, peaks, alerts] = await Promise.all([
    query<{ taken_at: Date; available_mb: number; commit_mb: number | null }>(
      `select taken_at, available_mb, commit_mb from server_memory_samples where taken_at > now() - interval '24 hours' order by taken_at`),
    query<{ name: string; peak: number }>(
      `select app->>'name' as name, max((app->>'privateMb')::int) as peak
       from server_memory_samples, jsonb_array_elements(apps) app where taken_at > now() - interval '24 hours' group by 1`),
    query<MemoryAlert>(
      `select id, kind, subject, level, message, opened_at, last_seen_at, resolved_at, (notified_at is not null) as notified
       from server_alerts where resolved_at is null or resolved_at > now() - interval '7 days' order by resolved_at nulls first, opened_at desc limit 50`),
  ])
  const peakByApp = new Map(peaks.rows.map(row => [row.name, row.peak]))
  const { startMethodOverview } = await import('@/lib/start-methods')
  const startMethods = await startMethodOverview(snapshot).catch(error => { console.error('[memory] start methods:', error); return [] })
  const { rows: stagingRows } = await query<{ id: string; name: string; pm2_name: string; sleep_after_minutes: number | null; sleeping_since: Date | null; last_active_at: Date | null }>(
    `select id, name, pm2_name, sleep_after_minutes, sleeping_since, last_active_at from projects where environment = 'staging' order by name`)
  const staging = stagingRows.map(row => {
    const app = snapshot.apps.find(item => item.name === row.pm2_name)
    return { projectId: row.id, label: row.name, running: !!app, privateMb: app?.privateMb ?? 0, sleepAfterMinutes: row.sleep_after_minutes,
      sleepingSince: row.sleeping_since?.toISOString() ?? null, lastActiveAt: row.last_active_at?.toISOString() ?? null }
  })
  return {
    startMethods, staging,
    snapshot: { ...snapshot, apps: snapshot.apps.map(app => ({ ...app, peakMb: Math.max(app.privateMb, peakByApp.get(app.name) ?? 0) })) },
    history: downsample(history.rows.map(row => ({ takenAt: row.taken_at.toISOString(), availableMb: row.available_mb, commitMb: row.commit_mb })), 288),
    alerts: alerts.rows,
    thresholds: { lowMemoryMb: lowMemoryThreshold(snapshot.totalMb), buildMinFreeMb: buildMemoryFloorMb(), buildConcurrency: buildLimit() },
  }
}

/** One app's memory now, its peak over the last day, and any open alert about it. */
export async function appMemory(projectId: string) {
  await ensureServerMemorySchema()
  const { rows } = await query<{ pm2_name: string; memory_limit_mb: number | null }>('select pm2_name, memory_limit_mb from projects where id=$1', [projectId])
  if (!rows[0]) return null
  const snapshot = await currentMemorySnapshot()
  const usage = snapshot.apps.find(app => app.name === rows[0].pm2_name)
  const { rows: peak } = await query<{ peak: number | null }>(
    `select max((app->>'privateMb')::int) as peak from server_memory_samples, jsonb_array_elements(apps) app
     where taken_at > now() - interval '24 hours' and app->>'name' = $1`, [rows[0].pm2_name])
  const { rows: alerts } = await query<MemoryAlert>(
    `select id, kind, subject, level, message, opened_at, last_seen_at, resolved_at, (notified_at is not null) as notified
     from server_alerts where subject=$1 and resolved_at is null`, [rows[0].pm2_name])
  return {
    running: !!usage, usageMb: usage?.privateMb ?? 0, processes: usage?.processes ?? 0,
    peakMb: Math.max(usage?.privateMb ?? 0, peak[0]?.peak ?? 0), limitMb: rows[0].memory_limit_mb,
    serverTotalMb: snapshot.totalMb, alerts,
  }
}
