import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows } = await query(
      `select d.id, d.project_id, d.user_id, d.status, d.branch, d.commit_sha, d.started_at, d.finished_at,
              d.trigger, d.log, p.name as project_name, u.name as user_name
       from deployments d
       join projects p on p.id = d.project_id
       left join users u on u.id = d.user_id
       where d.id = $1
       limit 1`,
      [(await context.params).id]
    )

    if (!rows[0]) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }

    return NextResponse.json(rows[0])
  } catch (error) {
    return jsonError(error)
  }
}
