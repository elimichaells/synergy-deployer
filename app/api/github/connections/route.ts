import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { createGitHubConnection, listGitHubConnections } from '@/lib/github-connections'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ connections: await listGitHubConnections() })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => null)
    const connection = await createGitHubConnection(String(body?.name || ''), String(body?.token || ''), user?.id)
    await audit(user?.id, 'github.connection.create', connection.id, { name: connection.name, account: connection.account_login })
    return NextResponse.json(connection, { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
