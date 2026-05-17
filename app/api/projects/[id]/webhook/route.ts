import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

export async function GET(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const { rows } = await query<{ webhook_secret: string | null }>(
      'SELECT webhook_secret FROM projects WHERE id = $1',
      [context.params.id]
    )

    if (rows.length === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const secret = rows[0].webhook_secret
    return NextResponse.json({
      hasSecret: !!secret,
      secret: secret || null,
      webhookUrl: 'https://deploy.smartcloudgh.com/api/webhooks/github',
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const secret = randomBytes(32).toString('hex')

    const { rowCount } = await query(
      'UPDATE projects SET webhook_secret = $1, updated_at = now() WHERE id = $2',
      [secret, context.params.id]
    )

    if (rowCount === 0) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Audit log
    await query(
      `INSERT INTO audit_logs (user_id, action, resource, details)
       VALUES ($1, 'webhook_secret_generated', $2, $3)`,
      [user?.id, `project:${context.params.id}`, JSON.stringify({ projectId: context.params.id })]
    )

    return NextResponse.json({
      secret,
      webhookUrl: 'https://deploy.smartcloudgh.com/api/webhooks/github',
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    await query(
      'UPDATE projects SET webhook_secret = NULL, updated_at = now() WHERE id = $1',
      [context.params.id]
    )

    return NextResponse.json({ status: 'removed' })
  } catch (error) {
    return jsonError(error)
  }
}
