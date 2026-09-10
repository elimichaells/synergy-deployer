import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { rotateProjectDataServicePassword } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function POST(request: Request, context: { params: Promise<{ id: string; serviceId: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const params = await context.params
    const body = await request.json().catch(() => ({}))
    const service = await rotateProjectDataServicePassword(params.id, params.serviceId, body.password)
    await audit(user?.id, 'project.data-service.rotate-password', `project:${params.id}`, { serviceId: params.serviceId })
    return NextResponse.json({ ok: true, service })
  } catch (error) {
    return jsonError(error)
  }
}
