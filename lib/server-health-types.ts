export interface ServerIncident {
  id: string; key: string; severity: 'warning' | 'critical'; message: string; action: string
  openedAt: string; lastSeenAt: string; resolvedAt?: string
  source?: string; href?: string
  service?: string; endpoint?: string; expected?: string; observed?: string
  responseMs?: number; dependency?: string; issueCode?: string; detail?: string
}
export interface ServerHealth {
  checkedAt: string | null; stale: boolean; unavailable: boolean
  incidents: ServerIncident[]
  snapshot: null | {
    disks: { name: string; free: number; total: number }[]
    memory: { free: number; total: number }
    pm2Updates: number; pm2Error: boolean; collectorError: string | null
    apps: { name: string; status: string | null; restarts: number; health?: 'ready' | 'degraded' | 'offline' | 'stopped' | 'unknown' }[]
    checks: { name: string; ok: boolean; status: number | null; ms: number; reason?: string; endpoint?: string; expected?: string; diagnostics?: { dependency: string; detail: string; issueCode: string; nextStep: string } }[]
  }
}
