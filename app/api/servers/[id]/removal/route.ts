import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { reviewServerRemoval, removeServer } from '@/lib/server-removal'
import { updateProtected } from '@/lib/update-maintenance'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: Context) {
  try {
    requireRole(await getSessionFromCookie(), ['admin'])
    return NextResponse.json(await reviewServerRemoval((await context.params).id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin']); requireSameOrigin(request)
    const body = await readBody(request, 4096), id = (await context.params).id
    return NextResponse.json(await updateProtected('Remove managed server', () => removeServer(id, body, user!.id)), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
