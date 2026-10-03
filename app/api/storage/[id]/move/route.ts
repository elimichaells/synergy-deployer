import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { latestDatabaseMove, planDatabaseMove, startDatabaseMove } from '@/lib/database-move'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** What moving this database to another server would involve, and the last move of it. */
export async function GET(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const id = (await context.params).id
    const target = new URL(request.url).searchParams.get('target') || undefined
    const [plan, latest] = await Promise.all([planDatabaseMove(id, target), latestDatabaseMove(id)])
    return NextResponse.json({ plan, latest, canMove: user?.role === 'admin' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/** Starts the move. Administrators only; the database name must be typed to confirm. */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => null)
    const move = await startDatabaseMove((await context.params).id, typeof body?.targetConnectionId === 'string' ? body.targetConnectionId : undefined, body?.confirm, user?.id)
    return NextResponse.json({ move })
  } catch (error) { return jsonError(error) }
}
