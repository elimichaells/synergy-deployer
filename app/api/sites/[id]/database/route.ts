import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { getProjectDatabase, provisionProjectDatabase, rotateProjectDatabasePassword } from '@/lib/project-databases'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ database: await getProjectDatabase((await context.params).id) })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => ({}))
    const action = body.action || 'create'
    if (!['create', 'rotate_password'].includes(action)) {
      return NextResponse.json({ error: 'Invalid database action' }, { status: 400 })
    }
    const database = action === 'create'
      ? await provisionProjectDatabase((await context.params).id, user?.id)
      : await rotateProjectDatabasePassword((await context.params).id)
    await audit(user?.id, `project.database.${action}`, (await context.params).id, { database: database?.database_name })
    return NextResponse.json({ database }, { status: action === 'create' ? 201 : 200 })
  } catch (error) {
    return jsonError(error)
  }
}
