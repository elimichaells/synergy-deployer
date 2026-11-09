import {readBody,requireSameOrigin} from '@/lib/request-body'
import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { activateDataMigration } from '@/lib/data-migrations'
import { requireRole } from '@/lib/rbac'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin']); requireSameOrigin(request)
    const id = (await context.params).id
    await activateDataMigration(id)
    await audit(user?.id, 'data.migration.activate', id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
