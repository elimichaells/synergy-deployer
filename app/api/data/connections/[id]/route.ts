import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { deleteDataConnection, updateDataConnection } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const connection = await updateDataConnection((await context.params).id, await request.json())
    await audit(user?.id, 'data.connection.update', (await context.params).id, { name: connection?.name })
    return NextResponse.json({ connection })
  } catch (error) { return jsonError(error) }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await deleteDataConnection((await context.params).id)
    await audit(user?.id, 'data.connection.delete', (await context.params).id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
