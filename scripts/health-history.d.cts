export interface HistoryStats {
  passed: number; failed: number; unknown: number; paused: number
  latencyCount: number; totalMs: number; maxMs: number
  successPercent: number | null; averageMs: number | null
}
export interface HealthHistory {
  range: string; service: string | null; from: number; to: number; intervalMs: number
  startedAt: number | null; checkedAt: number | null; summary: HistoryStats
  services: (HistoryStats & { name: string })[]
  points: (HistoryStats & { at: number; missing: number; state: 'gap' | 'failed' | 'unknown' | 'healthy' | 'paused' | 'partial' })[]
  unavailable: boolean; stale: boolean
}
export function summarizeHistory(history: unknown, range: string, service?: string, now?: number): Omit<HealthHistory, 'unavailable' | 'stale'>
