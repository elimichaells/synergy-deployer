import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { getProject, renameProject } from '@/lib/projects'
import { requireRole } from '@/lib/rbac'

type Context = { params: Promise<{ id: string }> }

export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ project: await getProject((await context.params).id), canWrite: user?.role !== 'viewer', isAdmin: user?.role === 'admin' })
  } catch (error) { return jsonError(error) }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    const body = await request.json().catch(() => ({}))
    await renameProject(id, body.name)
    await audit(user?.id, 'project.rename', id, { name: body.name })
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
