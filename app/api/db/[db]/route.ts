import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { dropDatabase } from '@/lib/db-admin'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function DELETE(request: Request, context: { params: Promise<{ db: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const name = decodeURIComponent((await context.params).db)

    // Require the caller to re-type the database name — no accidental drops
    const body = await request.json().catch(() => null)
    if (body?.confirm !== name) {
      return NextResponse.json(
        { error: 'Confirmation mismatch: send { "confirm": "<database name>" }' },
        { status: 400 }
      )
    }

    await dropDatabase(name)
    await audit(user?.id, 'database.drop', name)

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
