import os from 'os'
import { db } from '@/lib/db'

type Append = (message: string) => void | Promise<void>

export function installationLimit(value = process.env.MANAGER_INSTALL_CONCURRENCY) {
  const limit = Number(value || 2)
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('MANAGER_INSTALL_CONCURRENCY must be an integer from 1 to 4')
  return limit
}

// Session locks work across route bundles and Manager processes, and release on disconnect.
export async function withInstallationSlot<T>(work: () => Promise<T>, append: Append, checkCancelled: () => void) {
  const limit = installationLimit()
  const started = Date.now()
  let lastNotice = 0
  while (true) {
    checkCancelled()
    if (Date.now() - started > 20 * 60_000) throw new Error('Installation queue exceeded twenty minutes; retry when the host is less busy')
    const client = await db.connect()
    let slot = -1
    let connectionError: Error | undefined
    const onError = (error: Error) => { connectionError = error }
    client.on('error', onError)
    try {
      for (let index = 0; index < limit; index++) {
        const result = await client.query("select pg_try_advisory_lock(hashtext('manager-heavy-install'),$1) as locked", [index])
        if (result.rows[0].locked) { slot = index; break }
      }
      if (slot >= 0) {
        checkCancelled()
        if (connectionError) throw connectionError
        await append(`[capacity] Installation slot ${slot + 1}/${limit} acquired\n`)
        const result = await work()
        if (connectionError) throw new Error('Installation lock connection was lost; candidate will not be activated')
        return result
      }
    } finally {
      try {
        if (slot >= 0 && !connectionError) await client.query("select pg_advisory_unlock(hashtext('manager-heavy-install'),$1)", [slot])
      } finally { client.removeListener('error', onError); client.release(!!connectionError) }
    }
    if (Date.now() - lastNotice >= 30_000) {
      await append(`[capacity] Waiting for an installation slot (${Math.floor((Date.now() - started) / 1000)}s); current release stays online\n`)
      lastNotice = Date.now()
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

export function buildLimit(value = process.env.MANAGER_BUILD_CONCURRENCY) {
  const limit = Number(value || 1)
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('MANAGER_BUILD_CONCURRENCY must be an integer from 1 to 4')
  return limit
}

/** Free memory a build waits for. Framework builds commonly need 1 to 4 GB of their own. */
export function buildMemoryFloorMb(value = process.env.MANAGER_BUILD_MIN_FREE_MB) {
  const floor = Number(value || 2048)
  if (!Number.isInteger(floor) || floor < 0 || floor > 65536) throw new Error('MANAGER_BUILD_MIN_FREE_MB must be a whole number of megabytes from 0 to 65536')
  return floor
}

const BUILD_QUEUE_LIMIT_MS = 30 * 60_000
const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`

/**
 * Runs a build only when a build slot is free and the server has enough free memory, so several
 * builds cannot starve the apps that are running. Waiting never touches the live release.
 */
export async function withBuildSlot<T>(work: () => Promise<T>, append: Append, checkCancelled: () => void,
  availableMb: () => number = () => Math.round(os.freemem() / 1024 / 1024), pauseMs = 5_000) {
  const limit = buildLimit()
  const floor = buildMemoryFloorMb()
  const started = Date.now()
  let lastNotice = 0
  let waitingFor: 'memory' | 'slot' | null = null
  while (true) {
    checkCancelled()
    const free = availableMb()
    if (Date.now() - started > BUILD_QUEUE_LIMIT_MS) {
      throw new Error(waitingFor === 'memory'
        ? `Not enough free memory to build safely after 30 minutes (${gb(free)} free, ${gb(floor)} needed). The live app is unchanged; deploy again when the server is less busy`
        : 'Build queue exceeded 30 minutes; the live app is unchanged. Retry when other deployments have finished')
    }
    if (free >= floor) {
      const client = await db.connect()
      let slot = -1
      let connectionError: Error | undefined
      const onError = (error: Error) => { connectionError = error }
      client.on('error', onError)
      try {
        for (let index = 0; index < limit; index++) {
          const result = await client.query("select pg_try_advisory_lock(hashtext('manager-build'),$1) as locked", [index])
          if (result.rows[0].locked) { slot = index; break }
        }
        if (slot >= 0) {
          checkCancelled()
          if (connectionError) throw connectionError
          await append(`[capacity] Build slot ${slot + 1}/${limit} acquired with ${gb(free)} memory free\n`)
          return await work()
        }
      } finally {
        try {
          if (slot >= 0 && !connectionError) await client.query("select pg_advisory_unlock(hashtext('manager-build'),$1)", [slot])
        } finally { client.removeListener('error', onError); client.release(!!connectionError) }
      }
      waitingFor = 'slot'
    } else waitingFor = 'memory'
    if (Date.now() - lastNotice >= 30_000) {
      const waited = Math.floor((Date.now() - started) / 1000)
      await append(waitingFor === 'memory'
        ? `[capacity] Waiting for memory before building: ${gb(free)} free, builds need ${gb(floor)} (${waited}s); current release stays online\n`
        : `[capacity] Waiting for another build to finish (${waited}s); current release stays online\n`)
      lastNotice = Date.now()
    }
    await new Promise(resolve => setTimeout(resolve, pauseMs))
  }
}
