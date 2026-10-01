import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listShareableDataServices } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ services: await listShareableDataServices((await context.params).id) })
  } catch (error) { return jsonError(error) }
}
