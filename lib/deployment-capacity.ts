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
