import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { signSession, setSessionCookie, verifyPassword } from '@/lib/auth'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const { rows } = await query<{
    id: string
    email: string
    name: string
    password_hash: string
    role: 'admin' | 'operator' | 'viewer'
    status: string
  }>(
    'select id, email, name, password_hash, role, status from users where email = $1 limit 1',
    [body.email]
  )

  const user = rows[0]
  if (!user || user.status !== 'active') {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  const ok = await verifyPassword(body.password, user.password_hash)
  if (!ok) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  await query('update users set last_login_at = now() where id = $1', [user.id])

  const token = signSession({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })

  setSessionCookie(token)

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  })
}
