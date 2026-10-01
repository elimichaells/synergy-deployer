import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { revealConnection } from '@/lib/storage'

export const dynamic = 'force-dynamic'

/** Admins can copy a database's full connection string; every reveal is audited. */
export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const connection = await revealConnection(id)
    await audit(user?.id, 'storage.reveal-credentials', id, {})
    return NextResponse.json(connection, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
