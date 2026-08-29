import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { testGitHubConnection } from '@/lib/github-connections'

export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const result = await testGitHubConnection(context.params.id)
    await audit(user?.id, 'github.connection.test', context.params.id, { healthy: true, account: result.accountLogin })
    return NextResponse.json(result)
  } catch (error) {
    return jsonError(error)
  }
}
