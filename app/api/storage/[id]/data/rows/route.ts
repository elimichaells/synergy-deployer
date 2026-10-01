import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { getTableRows } from '@/lib/db-admin'
import { explorerTarget } from '@/lib/storage'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const url = new URL(request.url)
    const table = url.searchParams.get('table')
    if (!table) throw new ApiError('Choose a table', 400)
    const { database, target } = await explorerTarget((await context.params).id)
    const result = await getTableRows(database, url.searchParams.get('schema') || 'public', table, parseInt(url.searchParams.get('page') || '1', 10), parseInt(url.searchParams.get('pageSize') || '50', 10), target)
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
