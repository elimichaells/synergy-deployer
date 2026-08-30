import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listProjectDataServices, provisionProjectDataService } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ services: await listProjectDataServices((await context.params).id) })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const service = await provisionProjectDataService((await context.params).id, await request.json(), user?.id)
    await audit(user?.id, 'project.data-service.create', (await context.params).id, { service: service?.name, provider: service?.provider })
    return NextResponse.json({ service }, { status: 201 })
  } catch (error) { return jsonError(error) }
}
