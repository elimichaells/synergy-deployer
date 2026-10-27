import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { requireSameOrigin, readBody } from '@/lib/request-body'
import { cleanupStatus, setCleanupEnabled, startReleaseCleanup } from '@/lib/release-cleanup'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET() {
  try {
    const user = await getSessionFromCookie(); requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ ...await cleanupStatus(), role: user!.role }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie(); requireRole(user, ['admin']); requireSameOrigin(request)
    const body = await readBody(request, 2000)
    if (body.action === 'settings') { await setCleanupEnabled(body.enabled, user!.id); return NextResponse.json({ ok: true }) }
    if (body.action !== 'scan' && body.action !== 'clean') throw new ApiError('Choose scan or cleanup', 400)
    return NextResponse.json(await startReleaseCleanup(body.action, 'manual', user!.id), { status: 202 })
  } catch (error) { return jsonError(error) }
}
