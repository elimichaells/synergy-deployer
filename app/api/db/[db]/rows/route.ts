import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getTableRows } from '@/lib/db-admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: { db: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const url = new URL(request.url)
    const schema = url.searchParams.get('schema') || 'public'
    const table = url.searchParams.get('table')
    if (!table) {
      return NextResponse.json({ error: 'Missing table parameter' }, { status: 400 })
    }

    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10)

    const result = await getTableRows(decodeURIComponent(context.params.db), schema, table, page, pageSize)
    return NextResponse.json(result)
  } catch (error) {
    return jsonError(error)
  }
}
