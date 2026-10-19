import { readFile, stat } from 'fs/promises'
import path from 'path'
import { managerDataRoot } from '@/lib/paths'
import { summarizeHistory } from '../scripts/health-history.cjs'

let cache: { file: string; mtime: number; value: unknown } | undefined
export async function readHealthHistory(range: string, service?: string) {
  const state = process.env.MANAGER_HEALTH_STATE_FILE || path.join(managerDataRoot(), 'monitor', 'state.json')
  const file = process.env.MANAGER_HEALTH_HISTORY_FILE || path.join(path.dirname(state), 'history.json')
  try {
    const info = await stat(file)
    if (info.size > 24 * 1024 ** 2) throw new Error('History exceeds its read limit')
    if (!cache || cache.file !== file || cache.mtime !== info.mtimeMs) {
      const value = JSON.parse(await readFile(file, 'utf8'))
      if (value.version !== 1 || !Array.isArray(value.buckets) || !Number.isFinite(value.lastSampleAt)) throw new Error('Invalid history')
      cache = { file, mtime: info.mtimeMs, value }
    }
    const result = summarizeHistory(cache.value, range, service)
    return { ...result, unavailable: false, stale: !result.checkedAt || Date.now() - result.checkedAt > 180_000 }
  } catch {
    return { ...summarizeHistory(null, range, service), unavailable: true, stale: true }
  }
}
