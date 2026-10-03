import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { wakeStagingApp } from '@/lib/staging-sleep'

export const dynamic = 'force-dynamic'

/** Starts a sleeping staging app now. It is ready in about as long as a restart takes. */
export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const { rows } = await query<{ environment: string | null }>('select environment from projects where id=$1', [id])
    if (!rows[0]) throw new ApiError('Application not found', 404)
    if (rows[0].environment !== 'staging') throw new ApiError('Only staging apps sleep', 400)
    return NextResponse.json({ state: wakeStagingApp(id, user?.id ?? null, 'button') })
  } catch (error) { return jsonError(error) }
}
