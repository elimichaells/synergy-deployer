import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { setProjectPinned } from '@/lib/project-pins'

type Context = { params: Promise<{ id: string }> }

export async function PUT(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const body = await request.json().catch(() => null)
    if (typeof body?.pinned !== 'boolean') throw new ApiError('Pinned must be true or false', 400)
    const pinned = await setProjectPinned(user!.id, (await context.params).id, body.pinned)
    return NextResponse.json({ pinned })
  } catch (error) { return jsonError(error) }
}
