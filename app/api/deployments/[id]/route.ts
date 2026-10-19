import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { ensureDeploymentSchema } from '@/lib/deployment-schema'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    await ensureDeploymentSchema()

    const after = new URL(request.url).searchParams.get('after')
    const offset = after === null ? null : Number(after)
    if (offset !== null && (!/^\d+$/.test(after!) || !Number.isSafeInteger(offset) || offset < 0 || offset > 2_147_483_647)) return NextResponse.json({ error: 'Invalid log cursor' }, { status: 400 })
    const logFields = offset === null ? 'd.log' : `substring(coalesce(d.log,'') from (case when $2::int > char_length(coalesce(d.log,'')) then 0 else $2::int end)+1 for 32768) as log_chunk,
      char_length(coalesce(d.log,'')) as log_length, ($2::int > char_length(coalesce(d.log,''))) as log_reset`

    const { rows } = await query(
      `select d.id, d.project_id, d.user_id, d.status, d.branch, d.commit_sha, d.started_at, d.finished_at,
              d.trigger, d.phase, d.security_status, ${logFields}, (p.active_deployment_id = d.id) as is_active,
              p.name as project_name, u.name as user_name
       from deployments d
       join projects p on p.id = d.project_id
       left join users u on u.id = d.user_id
       where d.id = $1
       limit 1`,
      offset === null ? [(await context.params).id] : [(await context.params).id, offset]
    )

    if (!rows[0]) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }

    const row = rows[0]
    if (offset !== null) {
      row.log_next = (row.log_reset ? 0 : offset) + Array.from(row.log_chunk || '').length
      row.log_complete = row.log_next >= row.log_length
      delete row.log_length
    }
    return NextResponse.json(row, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return jsonError(error)
  }
}
