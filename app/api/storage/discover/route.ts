import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { discoverDatabases } from '@/lib/storage'

export const dynamic = 'force-dynamic'

/** Databases an app's env files point at that Synergy does not track yet. */
export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const projectId = new URL(request.url).searchParams.get('project') || undefined
    return NextResponse.json({ discovered: (await discoverDatabases(projectId)).filter(item => !item.linked) })
  } catch (error) { return jsonError(error) }
}
