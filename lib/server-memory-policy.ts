/** Rules for measuring and protecting the server's memory. Pure and testable. */

const MB = 1024 * 1024

export interface ProcessRow { pid: number; ppid: number; name: string; privateBytes: number; workingBytes: number; started?: number
  /** Starts the app rather than being it: the manager's runner, npm, cross-env or a shell. */
  launcher?: boolean }
export interface AppMemory { name: string; privateMb: number; workingMb: number; processes: number; overheadMb: number }
export interface OtherMemory { name: string; count: number; privateMb: number }

/**
 * Charges every process to the PM2 app whose process tree it belongs to. An app started through
 * the manager's runner is a chain (runner, shell, npm, shell, app), so PM2's own figure for the
 * runner alone misses almost all of it.
 */
export function attributeMemory(processes: ProcessRow[], roots: Map<number, string>, otherLimit = 12) {
  const byPid = new Map(processes.map(row => [row.pid, row]))
  const memo = new Map<number, string | null>()
  const owner = (pid: number): string | null => {
    const path: number[] = []
    let current = pid
    let result: string | null = null
    while (true) {
      if (memo.has(current)) { result = memo.get(current)!; break }
      if (roots.has(current)) { result = roots.get(current)!; break }
      path.push(current)
      const row = byPid.get(current)
      const parent = row ? byPid.get(row.ppid) : undefined
      // Windows reuses process ids: a "parent" that started after its child is someone else.
      if (!row || !parent || row.ppid === current || path.length > 32) break
      if (parent.started !== undefined && row.started !== undefined && parent.started > row.started) break
      current = row.ppid
    }
    for (const id of path) memo.set(id, result)
    return result
  }

  // What a direct start would save: the processes that only start the app.
  const launcher = (row: ProcessRow) => !!row.launcher || /^(cmd|conhost)(\.exe)?$/i.test(row.name)

  const apps = new Map<string, AppMemory>()
  const others = new Map<string, OtherMemory>()
  for (const row of processes) {
    const app = owner(row.pid)
    if (app) {
      const entry = apps.get(app) || { name: app, privateMb: 0, workingMb: 0, processes: 0, overheadMb: 0 }
      entry.privateMb += row.privateBytes / MB
      entry.workingMb += row.workingBytes / MB
      if (launcher(row)) entry.overheadMb += row.privateBytes / MB
      entry.processes++
      apps.set(app, entry)
    } else {
      const name = row.name.replace(/\.exe$/i, '')
      const entry = others.get(name) || { name, count: 0, privateMb: 0 }
      entry.count++
      entry.privateMb += row.privateBytes / MB
      others.set(name, entry)
    }
  }
  const round = <T extends { privateMb: number; workingMb?: number; overheadMb?: number }>(entry: T) => ({ ...entry, privateMb: Math.round(entry.privateMb),
    ...(entry.workingMb !== undefined ? { workingMb: Math.round(entry.workingMb) } : {}), ...(entry.overheadMb !== undefined ? { overheadMb: Math.round(entry.overheadMb) } : {}) })
  return {
    apps: [...apps.values()].map(round).sort((a, b) => b.privateMb - a.privateMb),
    others: [...others.values()].map(round).sort((a, b) => b.privateMb - a.privateMb).slice(0, otherLimit),
  }
}

export interface MemorySample {
  takenAt: string
  totalMb: number
  availableMb: number
  commitMb: number | null
  commitLimitMb: number | null
  apps: { name: string; privateMb: number }[]
}

export interface AlertCondition { kind: 'low_memory' | 'commit_high' | 'app_over_limit' | 'app_growing'; subject: string; level: 'warning' | 'error'; message: string; details: Record<string, unknown> }

/** Available memory below this is a warning: a tenth of the server, and never less than 1.5 GB. */
export const lowMemoryThreshold = (totalMb: number) => Math.max(Math.round(totalMb * 0.1), 1536)
const CONSECUTIVE = 3
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

/**
 * What is wrong right now, from samples taken about a minute apart (oldest first). A condition must
 * hold for three samples in a row so a short spike, such as a build, does not raise an alarm.
 * `labels` turns PM2 names into the names people know the apps by.
 */
export function evaluateMemory(samples: MemorySample[], limits: Map<string, number>, labels: Map<string, string> = new Map()): AlertCondition[] {
  const recent = samples.slice(-CONSECUTIVE)
  if (recent.length < CONSECUTIVE) return []
  const latest = recent[recent.length - 1]
  const conditions: AlertCondition[] = []

  const threshold = lowMemoryThreshold(latest.totalMb)
  if (recent.every(sample => sample.availableMb < threshold)) {
    const critical = latest.availableMb < latest.totalMb * 0.05
    conditions.push({ kind: 'low_memory', subject: 'server', level: critical ? 'error' : 'warning',
      message: `Only ${gb(latest.availableMb)} of ${gb(latest.totalMb)} memory is free. Apps and deployments may slow down or fail.`,
      details: { availableMb: latest.availableMb, totalMb: latest.totalMb, thresholdMb: threshold } })
  }

  if (recent.every(sample => sample.commitMb !== null && sample.commitLimitMb && sample.commitMb / sample.commitLimitMb >= 0.9)) {
    conditions.push({ kind: 'commit_high', subject: 'server', level: 'error',
      message: `Windows has promised ${gb(latest.commitMb!)} of its ${gb(latest.commitLimitMb!)} limit (memory plus page file). When it runs out, programs crash.`,
      details: { commitMb: latest.commitMb, commitLimitMb: latest.commitLimitMb } })
  }

  for (const [app, limit] of limits) {
    const usage = recent.map(sample => sample.apps.find(entry => entry.name === app)?.privateMb ?? 0)
    if (usage.every(value => value > limit)) {
      conditions.push({ kind: 'app_over_limit', subject: app, level: 'warning',
        message: `${labels.get(app) || app} uses ${gb(usage[usage.length - 1])}, over its ${gb(limit)} limit.`,
        details: { usageMb: usage[usage.length - 1], limitMb: limit } })
    }
  }

  // Growth: compare the last few minutes with the same app about six hours earlier.
  const latestTime = Date.parse(latest.takenAt)
  const earlier = samples.filter(sample => {
    const age = latestTime - Date.parse(sample.takenAt)
    return age >= 5.5 * 3600_000 && age <= 6.5 * 3600_000
  })
  if (earlier.length >= CONSECUTIVE) {
    const average = (list: MemorySample[], app: string) => list.reduce((sum, sample) => sum + (sample.apps.find(entry => entry.name === app)?.privateMb ?? 0), 0) / list.length
    for (const { name } of latest.apps) {
      const now = average(recent, name)
      const before = average(earlier, name)
      if (before > 0 && now >= 400 && now - before >= 300 && now >= before * 1.5) {
        conditions.push({ kind: 'app_growing', subject: name, level: 'warning',
          message: `${labels.get(name) || name} grew from ${gb(before)} to ${gb(now)} in six hours. It may be leaking memory.`,
          details: { fromMb: Math.round(before), toMb: Math.round(now) } })
      }
    }
  }
  return conditions
}

/** A limit with room to grow: half again above the recent peak, at least 512 MB, in 256 MB steps. */
export function suggestMemoryLimit(currentMb: number, peakMb: number) {
  const basis = Math.max(currentMb, peakMb, 0) * 1.5
  return Math.max(512, Math.ceil(basis / 256) * 256)
}

export const MIN_MEMORY_LIMIT_MB = 256

export function validateMemoryLimit(value: unknown, totalMb: number): number | null {
  if (value === null || value === '' || value === undefined) return null
  const limit = Number(value)
  if (!Number.isInteger(limit)) throw new Error('Enter the limit as a whole number of megabytes')
  if (limit < MIN_MEMORY_LIMIT_MB) throw new Error(`The limit must be at least ${MIN_MEMORY_LIMIT_MB} MB`)
  if (totalMb > 0 && limit > totalMb) throw new Error(`The limit cannot be more than the server's ${gb(totalMb)}`)
  return limit
}

/** Node's heap gets three quarters of the app's limit; the rest is code, buffers and native memory. */
export function heapLimitFor(limitMb: number) {
  return Math.max(192, Math.floor(limitMb * 0.75))
}

/** Adds or replaces the heap cap in an app's NODE_OPTIONS, keeping every other option it sets. */
export function withHeapLimit(existing: string | undefined, limitMb: number | null) {
  const kept = (existing || '').split(/\s+/).filter(option => option && !/^--max-old-space-size(=|$)/.test(option))
  if (limitMb) kept.push(`--max-old-space-size=${heapLimitFor(limitMb)}`)
  return kept.join(' ')
}

/** Keeps a chart readable: at most `points` samples, each the lowest value in its slice. */
export function downsample<T extends { availableMb: number }>(samples: T[], points: number): T[] {
  if (samples.length <= points) return samples
  const size = samples.length / points
  const out: T[] = []
  for (let index = 0; index < points; index++) {
    const slice = samples.slice(Math.floor(index * size), Math.floor((index + 1) * size))
    if (slice.length) out.push(slice.reduce((low, sample) => sample.availableMb < low.availableMb ? sample : low))
  }
  return out
}
