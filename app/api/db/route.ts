import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listDatabases, createDatabase, PROTECTED_DATABASES } from '@/lib/db-admin'
import { audit } from '@/lib/audit'
import { listProjectDatabases } from '@/lib/project-databases'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const [databases, projectDatabases] = await Promise.all([listDatabases(), listProjectDatabases()])
    return NextResponse.json({ databases, projectDatabases, protected: PROTECTED_DATABASES })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    const name: string = (body?.name || '').trim()
    if (!name) {
      return NextResponse.json({ error: 'Database name is required' }, { status: 400 })
    }

    const result = await createDatabase(name, {
      withOwner: body?.withOwner === true,
      ownerName: typeof body?.ownerName === 'string' && body.ownerName.trim() ? body.ownerName.trim() : undefined,
    })

    await audit(user?.id, 'database.create', name, result.owner ? { owner: result.owner.username } : undefined)

    // The password is returned exactly once and never stored
    return NextResponse.json(result)
  } catch (error) {
    return jsonError(error)
  }
}
