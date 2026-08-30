import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { testDataConnection } from '@/lib/data-services'
import { requireRole } from '@/lib/rbac'

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const result = await testDataConnection((await context.params).id)
    await audit(user?.id, 'data.connection.test', (await context.params).id, result)
    return NextResponse.json(result)
  } catch (error) { return jsonError(error) }
}
