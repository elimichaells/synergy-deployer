import { NextResponse } from 'next/server'
import { getProjectDatabaseUrl } from '@/lib/project-databases'
import { validPgwebConnectToken } from '@/lib/pgweb-auth'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body || !validPgwebConnectToken(body.token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json({ database_url: await getProjectDatabaseUrl(String(body.resource || '')) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database connection unavailable'
    return NextResponse.json({ error: message }, { status: 404 })
  }
}
