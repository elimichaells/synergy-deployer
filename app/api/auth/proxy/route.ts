import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    return new NextResponse(null, { status: 204, headers: { 'X-Manager-User': user?.email || '' } })
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
