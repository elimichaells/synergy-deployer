import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { getStorageDatabase } from '@/lib/storage'

export const dynamic = 'force-dynamic'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ database: await getStorageDatabase((await context.params).id), isAdmin: user?.role === 'admin', canWrite: user?.role !== 'viewer' })
  } catch (error) { return jsonError(error) }
}
