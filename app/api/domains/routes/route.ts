import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { createDomainRoute, listDomainRoutes } from '@/lib/domain-routes'
import { requireRole } from '@/lib/rbac'

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ routes: await listDomainRoutes(new URL(request.url).searchParams.get('project') || undefined) })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const route = await createDomainRoute(await request.json(), user?.id)
    await audit(user?.id, 'domain.route.create', route?.id || '', { hostname: route?.hostname, path: route?.path_prefix, projectId: route?.project_id })
    return NextResponse.json({ route }, { status: 201 })
  } catch (error) { return jsonError(error) }
}
