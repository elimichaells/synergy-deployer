import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { relatedApplications, renameApplicationGroup, updateApplicationGroup } from '@/lib/application-groups'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ ...await relatedApplications((await context.params).id), canWrite: user?.role !== 'viewer' })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await updateApplicationGroup((await context.params).id, await request.json(), user?.id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const body = await request.json().catch(() => ({}))
    await renameApplicationGroup((await context.params).id, body.name, user?.id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    await updateApplicationGroup((await context.params).id, { unlink: true }, user?.id)
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
