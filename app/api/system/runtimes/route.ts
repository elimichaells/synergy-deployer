import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { installRuntime, listRuntimes } from '@/lib/runtimes'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ runtimes: await listRuntimes() })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => ({}))
    const runtime = typeof body.runtime === 'string' ? body.runtime : ''
    const result = await installRuntime(runtime)
    await audit(user?.id, 'runtime.install', runtime, { runtime: result.runtime })
    return NextResponse.json({ ok: true, ...result, runtimes: await listRuntimes() })
  } catch (error) {
    return jsonError(error)
  }
}
