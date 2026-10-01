import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { deleteDomainRoute } from '@/lib/domain-routes'
import { requireRole } from '@/lib/rbac'

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const route = await deleteDomainRoute(id)
    await audit(user?.id, 'domain.route.delete', id, { path: route.path_prefix, projectId: route.project_id })
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
