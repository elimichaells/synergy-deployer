import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listProjectDataServices } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ services: await listProjectDataServices() })
  } catch (error) { return jsonError(error) }
}
