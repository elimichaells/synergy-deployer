import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { dropServerDatabase } from '@/lib/storage'

export const dynamic = 'force-dynamic'

/** Drops a database that no app uses. The caller must send the database's name as confirmation. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string; name: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const { id, name } = await context.params
    const database = decodeURIComponent(name)
    const body = await request.json().catch(() => ({}))
    if (body?.confirm !== database) throw new ApiError('Type the database name to confirm', 400)
    await dropServerDatabase(id, database)
    await audit(user?.id, 'database.drop', database, { server: id })
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
