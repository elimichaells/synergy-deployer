import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getRuntimeVersionCatalog } from '@/lib/runtimes'

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json(await getRuntimeVersionCatalog(new URL(request.url).searchParams.get('runtime') || ''))
  } catch (error) { return jsonError(error) }
}
