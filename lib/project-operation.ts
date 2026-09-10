import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'

// Session locks coordinate console, checkout and deployment admission across Next bundles.
export async function acquireProjectOperation(id: string) {
  const client = await db.connect()
  let locked = false
  try {
    const result = await client.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtext('manager-project'),hashtext($1)) as locked`, [id])
    locked = result.rows[0].locked
    if (!locked) throw new ApiError('Another operation is running for this application', 409)
    const active = await client.query(`select id from deployments where project_id=$1 and status in ('queued','running') limit 1`, [id])
    if (active.rows.length) throw new ApiError('A deployment is running. Wait before changing the checkout or running commands.', 409)
    let released = false
    return async () => {
      if (released) return
      released = true
      try { await client.query(`select pg_advisory_unlock(hashtext('manager-project'),hashtext($1))`, [id]); client.release() }
      catch { client.release(true) }
    }
  } catch (error) {
    if (locked) {
      try { await client.query(`select pg_advisory_unlock(hashtext('manager-project'),hashtext($1))`, [id]) } catch { client.release(true); throw error }
    }
    client.release()
    throw error
  }
}
