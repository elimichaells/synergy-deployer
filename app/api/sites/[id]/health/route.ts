import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError, ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { applicationHealthProfile, saveApplicationHealthProfile } from '@/lib/health-profiles'
import { readServerHealth } from '@/lib/server-health'
type Context = { params: Promise<{ id: string }> }
async function project(context: Context) {
  const row = (await query<{ pm2_name: string }>('select pm2_name from projects where id=$1', [(await context.params).id])).rows[0]
  if (!row) throw new ApiError('Application not found', 404)
  return row
}
export async function GET(_: Request, context: Context) {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator', 'viewer'])
    const app = await project(context)
    const health = await readServerHealth()
    return NextResponse.json({ profile: await applicationHealthProfile(app.pm2_name), checkedAt: health.checkedAt, stale: health.stale,
      application: health.snapshot?.apps.find(x => x.name === app.pm2_name) || null,
      check: health.snapshot?.checks.find(x => x.name === app.pm2_name) || null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const app = await project(context)
    let profile
    try { profile = await saveApplicationHealthProfile(app.pm2_name, await request.json()) }
    catch (error) { throw new ApiError((error as Error).message, 400) }
    await audit(user?.id, 'project.health_updated', 'project:' + (await context.params).id, { ...profile })
    return NextResponse.json({ profile })
  } catch (error) { return jsonError(error) }
}
