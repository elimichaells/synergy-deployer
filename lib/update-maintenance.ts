import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ApiError } from './api'
import { config, maintenance } from '@/scripts/manager-update-state.cjs'

// Long operations register a durable lease before beginning. Update preflight
// refuses to interrupt them. Leases remain visible after an unexpected crash.
export async function updateProtected<T>(operation: string, work: () => Promise<T>): Promise<T> {
  if (maintenance()) throw new ApiError('Manager is being updated. Retry when recovery has finished.',503)
  let marker: string | null=null
  let stateRoot: string | null=null
  try {stateRoot=config().stateRoot} catch { /* Legacy installation has no updater yet. */ }
  if(stateRoot) {
    const folder=path.join(stateRoot,'operations');fs.mkdirSync(folder,{recursive:true})
    marker=path.join(folder,randomUUID()+'.json')
    fs.writeFileSync(marker,JSON.stringify({operation,pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600})
  }
  try {
    if(maintenance()) throw new ApiError('Manager is being updated. Retry when recovery has finished.',503)
    return await work()
  } finally {if(marker)fs.unlinkSync(marker)}
}
export { maintenance }
