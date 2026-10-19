import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { planDatabaseRename, renameDatabase } from '@/lib/database-rename'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(_request: Request, context: Context) {
  try {
    requireRole(await getSessionFromCookie(), ['admin'])
    return NextResponse.json({ plan: await planDatabaseRename((await context.params).id) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => null)
    return NextResponse.json(await renameDatabase((await context.params).id, body?.newName, body?.confirm, body?.acknowledge, user?.id))
  } catch (error) { return jsonError(error) }
}
