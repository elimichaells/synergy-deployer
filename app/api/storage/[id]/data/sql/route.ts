import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { runSql } from '@/lib/db-admin'
import { explorerTarget } from '@/lib/storage'

export const dynamic = 'force-dynamic'

/** Runs SQL against one database. Read-only unless the admin asks to allow writes; writes are audited. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => null)
    const sql = typeof body?.sql === 'string' ? body.sql.trim() : ''
    if (!sql) throw new ApiError('SQL is empty', 400)
    if (sql.length > 50_000) throw new ApiError('SQL is too long', 400)
    const readOnly = body?.allowWrites !== true
    const id = (await context.params).id
    const { database, target } = await explorerTarget(id)
    const result = await runSql(database, sql, readOnly, target)
    if (!readOnly) await audit(user?.id, 'database.query.write', database, { storageId: id, sql: sql.slice(0, 2000), command: result.command, rowCount: result.rowCount })
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
