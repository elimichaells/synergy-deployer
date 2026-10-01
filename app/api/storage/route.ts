import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { discoverDatabases, listStorage } from '@/lib/storage'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const [databases, discovered] = await Promise.all([listStorage(), discoverDatabases()])
    return NextResponse.json({ databases, discovered: discovered.filter(item => !item.linked), isAdmin: user?.role === 'admin' })
  } catch (error) { return jsonError(error) }
}
