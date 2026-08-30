import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { ensureGitHubWebhook, getGitHubWebhookStatus, removeGitHubWebhook } from '@/lib/github-webhooks'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    return NextResponse.json(await getGitHubWebhookStatus((await context.params).id))
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const result = await ensureGitHubWebhook((await context.params).id)
    await query(
      `insert into audit_logs (user_id, action, resource, details)
       values ($1, 'github_webhook_installed', $2, $3)`,
      [user?.id, `project:${(await context.params).id}`, JSON.stringify(result)]
    )
    return NextResponse.json(result)
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const result = await removeGitHubWebhook((await context.params).id)
    await query(
      `insert into audit_logs (user_id, action, resource, details)
       values ($1, 'github_webhook_removed', $2, $3)`,
      [user?.id, `project:${(await context.params).id}`, JSON.stringify(result)]
    )
    return NextResponse.json(result)
  } catch (error) {
    return jsonError(error)
  }
}
