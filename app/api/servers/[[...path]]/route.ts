import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { addServer, cancelQueuedJob, changeServer, listServers, queueRemoteDeploy, saveRemoteApp, serverCertificate, serverDetail } from '@/lib/managed-servers'
import { importRemoteApp, remoteSetup, remoteSetupEnvironment, changeRemoteSetup } from '@/lib/remote-app-setup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ path?: string[] }> }

export async function GET(_request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin','operator','viewer'])
    const parts = (await context.params).path || []
    if (parts.length === 4 && parts[1] === 'apps' && parts[3] === 'setup') return NextResponse.json(await remoteSetup(parts[0],parts[2]),{headers:{'Cache-Control':'no-store'}})
    if (parts.length === 4 && parts[1] === 'apps' && parts[3] === 'environment') {
      requireRole(user,['admin'])
      return NextResponse.json(await remoteSetupEnvironment(parts[0],parts[2]),{headers:{'Cache-Control':'no-store'}})
    }
    if (!parts.length) return NextResponse.json({ servers: await listServers(), role: user!.role, userId: user!.id, local: { hostname: os.hostname(), platform: process.platform } }, { headers: { 'Cache-Control': 'no-store' } })
    if (parts.length === 1 && parts[0] === 'agent') {
      requireRole(user, ['admin'])
      const source = await readFile(path.join(process.cwd(), 'scripts/manager-agent.cjs'), 'utf8')
      return new NextResponse(source, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="manager-agent.cjs"', 'Cache-Control': 'no-store' } })
    }
    if (parts.length === 2 && parts[1] === 'ca') {
      return new NextResponse(await serverCertificate(parts[0]), { headers: {
        'Content-Type': 'application/x-pem-file', 'Content-Disposition': `attachment; filename="manager-${parts[0]}-root-ca.crt"`, 'Cache-Control': 'no-store',
      } })
    }
    if (parts.length === 1) return NextResponse.json({ ...await serverDetail(parts[0]), role: user!.role })
    throw new ApiError('Not found', 404)
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin','operator'])
    requireSameOrigin(request)
    const parts = (await context.params).path || []
    const body = await readBody(request)
    if (parts.length === 4 && parts[1] === 'apps' && parts[3] === 'deploy') return NextResponse.json(await queueRemoteDeploy(parts[0], parts[2], user!.id), { status: 202 })
    if (parts.length === 4 && parts[1] === 'jobs' && parts[3] === 'cancel') return NextResponse.json(await cancelQueuedJob(parts[0],parts[2],user!.id))
    requireRole(user, ['admin'])
    if (parts.length === 3 && parts[1] === 'apps' && parts[2] === 'import') return NextResponse.json(await importRemoteApp(parts[0],body,user!.id),{status:201})
    if (parts.length === 4 && parts[1] === 'apps' && parts[3] === 'setup') return NextResponse.json(await changeRemoteSetup(parts[0],parts[2],body,user!.id),{status:body.action==='save'?200:202})
    if (!parts.length) return NextResponse.json(await addServer(body, user!.id), { status: 201, headers: { 'Cache-Control': 'no-store' } })
    if (parts.length === 1) return NextResponse.json(await changeServer(parts[0],body.action,user!.id), { headers: { 'Cache-Control': 'no-store' } })
    if (parts.length === 2 && parts[1] === 'apps') return NextResponse.json(await saveRemoteApp(parts[0],null,body,user!.id), { status: 201 })
    if (parts.length === 3 && parts[1] === 'apps') return NextResponse.json(await saveRemoteApp(parts[0],parts[2],body,user!.id))
    throw new ApiError('Not found', 404)
  } catch (error) { return jsonError(error) }
}
