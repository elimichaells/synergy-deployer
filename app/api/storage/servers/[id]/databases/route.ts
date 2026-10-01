import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { createServerDatabase, listServerDatabases } from '@/lib/storage'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** Every database on one PostgreSQL server, including those no app tracks. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    return NextResponse.json(await listServerDatabases((await context.params).id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/** Creates an empty database, optionally with its own login. The password is shown once and never stored. */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const body = await request.json().catch(() => ({}))
    const result = await createServerDatabase(id, body?.name, body?.withOwner === true)
    await audit(user?.id, 'database.create', result.database, { server: id, owner: result.owner?.username })
    return NextResponse.json(result, { status: 201 })
  } catch (error) { return jsonError(error) }
}
