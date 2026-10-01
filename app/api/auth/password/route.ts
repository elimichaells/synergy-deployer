import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie, hashPassword, verifyPassword } from '@/lib/auth'
import { validatePassword } from '@/lib/user-admin-policy'

/** Lets any signed-in user change their own password after proving the current one. */
export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    if (!user) throw new ApiError('Sign in first', 401)
    const body = await request.json().catch(() => ({}))
    let next: string
    try { next = validatePassword(body.next) } catch (error) { throw new ApiError((error as Error).message, 400) }
    if (typeof body.current !== 'string') throw new ApiError('Enter your current password', 400)
    const row = (await query<{ password_hash: string }>('select password_hash from users where id = $1', [user.id])).rows[0]
    if (!row || !await verifyPassword(body.current, row.password_hash)) throw new ApiError('Your current password is not correct', 403)
    await query('update users set password_hash = $2 where id = $1', [user.id, await hashPassword(next)])
    await audit(user.id, 'user.password-changed', user.id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
