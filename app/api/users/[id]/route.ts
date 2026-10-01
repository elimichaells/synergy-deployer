import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ApiError, jsonError } from '@/lib/api'
import { forgetLiveAccount, getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { checkMemberChange } from '@/lib/user-admin-policy'

type Context = { params: Promise<{ id: string }> }

/** Change a team member's role, or disable or re-enable their account. */
export async function PATCH(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const { id } = await context.params
    const body = await request.json().catch(() => ({}))
    const target = (await query<{ id: string; role: string; status: string }>('select id, role, status from users where id = $1', [id])).rows[0]
    if (!target) throw new ApiError('Member not found', 404)
    const admins = Number((await query<{ count: string }>("select count(*) from users where role = 'admin' and status = 'active'")).rows[0].count)
    let change: ReturnType<typeof checkMemberChange>
    try { change = checkMemberChange({ actorId: user!.id, target, role: body.role, status: body.status, activeAdmins: admins }) } catch (error) { throw new ApiError((error as Error).message, 400) }
    const { rows } = await query(
      `update users set role = coalesce($2::user_role, role), status = coalesce($3, status) where id = $1
       returning id, email, name, role, status, created_at, last_login_at`,
      [id, change.role ?? null, change.status ?? null]
    )
    forgetLiveAccount(id)
    await audit(user?.id, 'user.updated', id, { ...change, email: rows[0].email })
    return NextResponse.json(rows[0])
  } catch (error) {
    return jsonError(error)
  }
}
