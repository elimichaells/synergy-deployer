import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { createDataConnection, DATA_PROVIDER_DEFAULT_PORTS, DATA_PROVIDERS, listDataConnections } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ connections: await listDataConnections(), providers: DATA_PROVIDERS, defaultPorts: DATA_PROVIDER_DEFAULT_PORTS })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const connection = await createDataConnection(await request.json(), user?.id)
    await audit(user?.id, 'data.connection.create', connection?.id || '', { name: connection?.name, provider: connection?.provider })
    return NextResponse.json({ connection }, { status: 201 })
  } catch (error) { return jsonError(error) }
}
