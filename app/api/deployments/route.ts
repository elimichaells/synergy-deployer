import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

export async function GET(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const url = new URL(request.url)
    const projectId = url.searchParams.get('project_id')
    const status = url.searchParams.get('status')
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)

    let sql = `select d.id, d.project_id, d.user_id, d.status, d.branch, d.commit_sha, d.started_at, d.finished_at,
              d.trigger, left(d.log, 2000) as log,
              p.name as project_name, u.name as user_name
       from deployments d
       join projects p on p.id = d.project_id
       left join users u on u.id = d.user_id`

    const conditions: string[] = []
    const params: unknown[] = []

    if (projectId) {
      conditions.push(`d.project_id = $${params.length + 1}`)
      params.push(projectId)
    }

    if (status) {
      conditions.push(`d.status = $${params.length + 1}`)
      params.push(status)
    }

    if (conditions.length > 0) {
      sql += ` where ${conditions.join(' and ')}`
    }

    sql += ` order by case d.status when 'running' then 0 when 'queued' then 1 else 2 end,
                    d.started_at desc
              limit $${params.length + 1}`
    params.push(limit)

    const { rows } = await query(sql, params)

    return NextResponse.json(rows)
  } catch (error) {
    return jsonError(error)
  }
}
