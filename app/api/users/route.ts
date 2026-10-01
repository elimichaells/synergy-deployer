import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie, hashPassword } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { validateNewUser } from '@/lib/user-admin-policy'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const { rows } = await query(
      `select id, email, name, role, status, created_at, last_login_at
       from users
       order by created_at desc`
    )

    return NextResponse.json(rows)
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    let member: ReturnType<typeof validateNewUser>
    try { member = validateNewUser(body) } catch (error) { throw new ApiError((error as Error).message, 400) }
    const existing = await query('select 1 from users where lower(email) = $1', [member.email])
    if (existing.rows.length) throw new ApiError('Someone with that email already has an account', 409)

    const passwordHash = await hashPassword(member.password)
    const { rows } = await query(
      `insert into users (email, name, password_hash, role)
       values ($1,$2,$3,$4)
       returning id, email, name, role, status, created_at`,
      [member.email, member.name, passwordHash, member.role]
    )
    await audit(user?.id, 'user.created', rows[0].id, { email: member.email, role: member.role })

    return NextResponse.json(rows[0], { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
