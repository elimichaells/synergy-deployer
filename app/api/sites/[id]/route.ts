import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

export async function GET(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows } = await query(
      `select p.id, p.name, p.slug, p.repo_url, p.default_branch, p.project_type, p.root_path, p.install_cmd, p.build_cmd, p.start_cmd, p.pre_deploy_cmd, p.post_deploy_cmd, p.pm2_name, p.port, p.url, p.is_active, p.environment, p.production_id, p.created_at, p.updated_at,
              s.id as staging_id, s.name as staging_name,
              prod.name as production_name
       from projects p
       left join projects s on s.production_id = p.id and s.environment = 'staging'
       left join projects prod on p.production_id = prod.id
       where p.id = $1`,
      [context.params.id]
    )

    if (!rows[0]) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(rows[0])
  } catch (error) {
    return jsonError(error)
  }
}

export async function PATCH(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }

    const fieldMap: Record<string, string> = {
      name: 'name',
      repoUrl: 'repo_url',
      defaultBranch: 'default_branch',
      projectType: 'project_type',
      rootPath: 'root_path',
      installCmd: 'install_cmd',
      buildCmd: 'build_cmd',
      startCmd: 'start_cmd',
      preDeployCmd: 'pre_deploy_cmd',
      postDeployCmd: 'post_deploy_cmd',
      pm2Name: 'pm2_name',
      port: 'port',
      url: 'url',
      isActive: 'is_active',
    }

    const updates: string[] = []
    const values: unknown[] = []

    Object.entries(fieldMap).forEach(([field, column]) => {
      if (body[field] !== undefined) {
        updates.push(`${column} = $${updates.length + 1}`)
        values.push(body[field])
      }
    })

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No changes' }, { status: 400 })
    }

    values.push(context.params.id)

    const { rows } = await query(
      `update projects set ${updates.join(', ')}, updated_at = now()
       where id = $${updates.length + 1}
       returning id, name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pre_deploy_cmd, post_deploy_cmd, pm2_name, port, url, is_active, created_at, updated_at`,
      values
    )

    const updatedProject = rows[0]

    // Update Caddy if URL/Port changed and valid
    if (updatedProject.url && updatedProject.port) {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy(updatedProject.url, updatedProject.port)
    }

    return NextResponse.json(updatedProject)
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    // Get URL before deleting to remove from Caddy
    const { rows } = await query('select url from projects where id = $1', [context.params.id])
    const project = rows[0]

    await query('delete from projects where id = $1', [context.params.id])

    if (project?.url) {
      const { removeFromCaddy } = await import('@/lib/caddy')
      await removeFromCaddy(project.url)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
