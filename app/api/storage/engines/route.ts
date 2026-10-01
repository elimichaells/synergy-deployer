import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { listEngines } from '@/lib/storage'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    return NextResponse.json({ engines: await listEngines(), isAdmin: user?.role === 'admin' })
  } catch (error) { return jsonError(error) }
}
