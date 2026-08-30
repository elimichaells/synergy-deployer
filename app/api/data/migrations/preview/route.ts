import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { previewDataMigration } from '@/lib/data-migrations'
import { requireRole } from '@/lib/rbac'

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json()
    return NextResponse.json({ preview: await previewDataMigration(String(body.sourceServiceId || ''), String(body.targetServiceId || '')) })
  } catch (error) { return jsonError(error) }
}
