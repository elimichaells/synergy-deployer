import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { switchStartMethod } from '@/lib/deploy'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** Restarts the app with or without the runner. It is offline for a few seconds, like a restart. */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const body = await request.json().catch(() => null)
    if (body?.method !== 'direct' && body?.method !== 'runner') throw new ApiError('Choose "direct" or "runner"', 400)
    let result
    try { result = await switchStartMethod(id, body.method) } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError((error as Error).message, 400)
    }
    await audit(user?.id, 'project.start_method_changed', `project:${id}`, { ...result })
    return NextResponse.json({ result })
  } catch (error) { return jsonError(error) }
}
