/** Rules for letting idle staging apps sleep. Pure and testable. */

export const SLEEP_CHOICES = [30, 60, 120, 240, 480] as const

export function validateSleepAfter(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const minutes = Number(value)
  if (!(SLEEP_CHOICES as readonly number[]).includes(minutes)) throw new Error(`Choose one of ${SLEEP_CHOICES.join(', ')} minutes, or never`)
  return minutes
}

export function sleepLabel(minutes: number | null) {
  if (!minutes) return 'Never'
  return minutes < 60 ? `After ${minutes} minutes idle` : `After ${minutes / 60} hour${minutes === 60 ? '' : 's'} idle`
}

export interface SleepCandidate {
  projectId: string
  environment: string | null
  sleepAfterMinutes: number | null
  running: boolean
  sleepingSince: string | null
  /** Last minute anyone had a connection open to the app. */
  lastActiveAt: string | null
  lastDeployAt: string | null
  deploying: boolean
}

/** The staging apps that have been idle long enough to stop now. */
export function appsToSleep(apps: SleepCandidate[], now: number) {
  return apps.filter(app => {
    if (app.environment !== 'staging' || !app.sleepAfterMinutes || !app.running || app.sleepingSince || app.deploying) return false
    const lastUse = Math.max(...[app.lastActiveAt, app.lastDeployAt].map(value => value ? Date.parse(value) : 0))
    // Without any record of use yet, wait a full period from now rather than stopping at once.
    if (!lastUse) return false
    return now - lastUse >= app.sleepAfterMinutes * 60_000
  })
}

/** Host names this page may wake: plain host names only, never a path or port trick. */
export function normalizeWakeHost(value: unknown) {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase().replace(/:\d+$/, '')
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null
}
