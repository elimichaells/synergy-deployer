import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { probeSsh, setupServerSsh, sshTarget } from '@/lib/server-ssh'
import { uuid } from '@/lib/managed-servers'
import { updateProtected } from '@/lib/update-maintenance'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 1800

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie(); requireRole(user,['admin']); requireSameOrigin(request)
    const id = uuid((await context.params).id)
    const body = await readBody(request,20000)
    if (body.action === 'probe') return NextResponse.json(await probeSsh(sshTarget(body)), { headers: { 'Cache-Control': 'no-store' } })
    if (body.action === 'setup') return NextResponse.json(await updateProtected('SSH server setup',() => setupServerSsh(id,body,user!.id)), { headers: { 'Cache-Control': 'no-store' } })
    throw new ApiError('Unknown SSH setup action',400)
  } catch (error) { return jsonError(error) }
}
