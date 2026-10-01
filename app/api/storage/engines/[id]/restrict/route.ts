import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { restrictToLocalhost } from '@/lib/storage'

/** Limits a PostgreSQL server on this machine to local connections (applies after its next restart). */
export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const result = await restrictToLocalhost(id)
    await audit(user?.id, 'storage.restrict-localhost', id, {})
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
