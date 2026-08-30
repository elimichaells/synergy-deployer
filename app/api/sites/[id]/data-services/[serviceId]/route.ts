import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { detachProjectDataService } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function DELETE(_: Request, context: { params: Promise<{ id: string; serviceId: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    await detachProjectDataService((await context.params).id, (await context.params).serviceId)
    await audit(user?.id, 'project.data-service.detach', (await context.params).id, { serviceId: (await context.params).serviceId })
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
