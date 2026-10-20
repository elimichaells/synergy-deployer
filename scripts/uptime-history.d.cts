export interface UptimeService {
  name: string; up: number; down: number; unknown: number; paused: number; missing: number; expected: number; checked: number
  percent: number | null; coverage: number; target: number; budgetSamplesRemaining: number
  assessment: string
}
export interface UptimeReport { range: string; from: number; to: number; startedAt: number | null; checkedAt: number | null; services: UptimeService[] }
export function summarizeUptime(history: unknown, range?: string, now?: number): UptimeReport
