import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { cancelDataMigration } from '@/lib/data-migrations'
import { requireRole } from '@/lib/rbac'

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    await cancelDataMigration(id)
    await audit(user?.id, 'data.migration.cancel', id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
