import type { ServerHealth } from './server-health-types'
export const applicationHealthLabels = { ready: 'Ready', degraded: 'Degraded', stopped: 'Stopped', offline: 'Offline', unknown: 'Health unknown' }
export function applicationState(health: ServerHealth | null, name: string) {
  if (!health || health.stale || health.unavailable || health.snapshot?.pm2Error) return 'unknown'
  const app = health.snapshot?.apps.find(a => a.name === name)
  return app?.health || 'unknown'
}
