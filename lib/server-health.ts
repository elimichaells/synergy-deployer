import { readFile } from 'fs/promises'
import path from 'path'
import { managerDataRoot } from '@/lib/paths'
import type { ServerHealth } from '@/lib/server-health-types'

export async function readServerHealth(): Promise<ServerHealth> {
  try {
    const file = process.env.MANAGER_HEALTH_STATE_FILE || path.join(managerDataRoot(), 'monitor', 'state.json')
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data.version !== 1 || !Number.isFinite(Date.parse(data.checkedAt)) || !Array.isArray(data.incidents) || !data.snapshot) throw new Error('Invalid monitor state')
    return { checkedAt: data.checkedAt, stale: Date.now() - Date.parse(data.checkedAt) > 180_000, unavailable: false, snapshot: data.snapshot, incidents: data.incidents }
  } catch { return { checkedAt: null, stale: true, unavailable: true, snapshot: null, incidents: [] } }
}
