import { statfsSync } from 'fs'
import { webRoot } from './paths'

export function diskCapacityError(free: number, total: number): string | null {
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return 'Disk space could not be measured; retry after checking server storage.'
  const minimum = Math.max(15 * 1024 ** 3, total * 0.1)
  return free <= minimum
    ? `Not enough disk space to deploy safely (${(free / 1024 ** 3).toFixed(1)} GB free; more than ${(minimum / 1024 ** 3).toFixed(1)} GB reserved). Free space or expand the volume. The live application has not been stopped.`
    : null
}

/** Refuse expensive installs/builds before they consume the origin's remaining storage. */
export function requireDeploymentDiskSpace() {
  let capacity
  try { capacity = statfsSync(webRoot()) } catch { throw new Error('Disk space could not be measured; check server storage before deploying.') }
  const error = diskCapacityError(capacity.bavail * capacity.bsize, capacity.blocks * capacity.bsize)
  if (error) throw new Error(error)
}
