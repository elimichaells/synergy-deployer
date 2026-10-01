import { NextResponse } from 'next/server'
import { getProjectDatabaseUrl } from '@/lib/project-databases'
import { validPgwebConnectToken } from '@/lib/pgweb-auth'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body || !validPgwebConnectToken(body.token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const resource = String(body.resource || '')
    // "svc-<id>" opens any PostgreSQL database known to Storage; access is admin-only via the proxy check.
    if (resource.startsWith('svc-')) {
      const { revealConnection } = await import('@/lib/storage')
      const { url } = await revealConnection(resource.slice(4))
      if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('Only PostgreSQL databases open in the browser')
      return NextResponse.json({ database_url: url.includes('sslmode=') ? url : `${url}?sslmode=disable` })
    }
    return NextResponse.json({ database_url: await getProjectDatabaseUrl(resource) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database connection unavailable'
    return NextResponse.json({ error: message }, { status: 404 })
  }
}
