import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { checkRuntimeUpdates } from '@/lib/runtimes'

export async function POST() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    return NextResponse.json({ runtimes: await checkRuntimeUpdates() })
  } catch (error) { return jsonError(error) }
}
