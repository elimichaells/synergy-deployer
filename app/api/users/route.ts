import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie, hashPassword } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

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
    if (!body?.email || !body?.name || !body?.password || !body?.role) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const passwordHash = await hashPassword(body.password)

    const { rows } = await query(
      `insert into users (email, name, password_hash, role)
       values ($1,$2,$3,$4)
       returning id, email, name, role, status, created_at`,
      [body.email, body.name, passwordHash, body.role]
    )

    return NextResponse.json(rows[0], { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
