import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listDatabaseRenames } from '@/lib/database-rename'
export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator', 'viewer'])
    return NextResponse.json({ renames: await listDatabaseRenames() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
