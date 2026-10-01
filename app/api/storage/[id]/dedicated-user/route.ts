import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { convertToDedicatedUser, planDedicatedUser } from '@/lib/dedicated-user'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** What switching this database to a dedicated user would change, and anything blocking it. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const full = await planDedicatedUser((await context.params).id)
    // The object list and old user names stay server-side; the page only needs counts.
    const plan = { ...full, objects: undefined, oldUsers: undefined }
    return NextResponse.json({ plan }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const body = await request.json().catch(() => ({}))
    if (body.confirm !== true) throw new ApiError('Confirm the switch to a dedicated user', 400)
    const result = await convertToDedicatedUser(id, user?.id)
    await audit(user?.id, 'storage.dedicated-user.completed', id, { role: result.role })
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
