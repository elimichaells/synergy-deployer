import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { reviewApplicationRemoval, removeApplication } from '@/lib/application-removal'
import { updateProtected } from '@/lib/update-maintenance'

export async function applicationRemovalRequest(request: Request, serverId: string | null, appId: string) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    if (request.method === 'GET') return NextResponse.json(await reviewApplicationRemoval(serverId, appId), { headers: { 'Cache-Control': 'no-store' } })
    requireSameOrigin(request)
    const body = await readBody(request, 4096)
    const result = await updateProtected('Remove application from Manager', () => removeApplication(serverId, appId, body, user!.id))
    return NextResponse.json(result, { status: 'jobId' in result ? 202 : 200, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
