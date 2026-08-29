import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { deleteGitHubConnection, updateGitHubConnection } from '@/lib/github-connections'

export async function PATCH(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => ({}))
    const connection = await updateGitHubConnection(context.params.id, {
      name: body.name === undefined ? undefined : String(body.name),
      token: body.token === undefined ? undefined : String(body.token),
    })
    await audit(user?.id, 'github.connection.update', context.params.id, { name: connection?.name })
    return NextResponse.json(connection)
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    await deleteGitHubConnection(context.params.id)
    await audit(user?.id, 'github.connection.delete', context.params.id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
