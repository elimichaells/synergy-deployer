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
      `select p.id, p.name, p.slug, p.repo_url, p.default_branch, p.project_type, p.root_path, p.install_cmd, p.build_cmd, p.deploy_script, p.start_cmd, p.pre_deploy_cmd, p.post_deploy_cmd, p.runtime_versions, p.pm2_name, p.port, p.url, p.auto_deploy, p.github_connection_id, p.is_active, p.environment, p.production_id, p.created_at, p.updated_at,
              s.id as staging_id, s.name as staging_name,
              prod.name as production_name, gc.name as github_connection_name, gc.account_login as github_account_login
       from projects p
       left join projects s on s.production_id = p.id and s.environment = 'staging'
       left join projects prod on p.production_id = prod.id
       left join github_connections gc on gc.id = p.github_connection_id
       where p.id = $1`,
      [(await context.params).id]
    )

    if (!rows[0]) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json(rows[0])
  } catch (error) {
    return jsonError(error)
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }

    if (body.deployScript !== undefined && body.deployScript !== null) {
      if (typeof body.deployScript !== 'string' || body.deployScript.length > 50_000) {
        return NextResponse.json({ error: 'Deployment script must be at most 50,000 characters' }, { status: 400 })
      }
    }
    if (body.autoDeploy !== undefined && typeof body.autoDeploy !== 'boolean') {
      return NextResponse.json({ error: 'Auto deploy must be true or false' }, { status: 400 })
    }
    if (body.runtimeVersions !== undefined) {
      const { validateProjectRuntimeVersions } = await import('@/lib/runtimes')
      body.runtimeVersions = validateProjectRuntimeVersions(body.runtimeVersions)
    }

    const { rows: previousRows } = await query<{ auto_deploy: boolean; github_connection_id: string | null }>(
      'select auto_deploy,github_connection_id from projects where id=$1',
      [(await context.params).id]
    )
    if (!previousRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const previous = previousRows[0]

    if (body.githubConnectionId !== undefined && body.githubConnectionId !== null) {
      if (typeof body.githubConnectionId !== 'string') return NextResponse.json({ error: 'Invalid GitHub connection' }, { status: 400 })
      const { rows } = await query<{ id: string }>('select id from github_connections where id=$1', [body.githubConnectionId])
      if (!rows[0]) return NextResponse.json({ error: 'GitHub connection not found' }, { status: 404 })
    }

    const fieldMap: Record<string, string> = {
      name: 'name',
      repoUrl: 'repo_url',
      defaultBranch: 'default_branch',
      projectType: 'project_type',
      rootPath: 'root_path',
      installCmd: 'install_cmd',
      buildCmd: 'build_cmd',
      deployScript: 'deploy_script',
      startCmd: 'start_cmd',
      preDeployCmd: 'pre_deploy_cmd',
      postDeployCmd: 'post_deploy_cmd',
      runtimeVersions: 'runtime_versions',
      autoDeploy: 'auto_deploy',
      githubConnectionId: 'github_connection_id',
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

    values.push((await context.params).id)

    const { rows } = await query(
      `update projects set ${updates.join(', ')}, updated_at = now()
       where id = $${updates.length + 1}
       returning id, name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, url, auto_deploy, github_connection_id, is_active, created_at, updated_at`,
      values
    )

    const updatedProject = rows[0]
    let webhook: { action: 'created' | 'updated'; repository: string } | null = null
    const shouldEnsureWebhook = body.autoDeploy === true || (body.githubConnectionId !== undefined && previous.auto_deploy)
    if (shouldEnsureWebhook) {
      try {
        const { ensureGitHubWebhook } = await import('@/lib/github-webhooks')
        webhook = await ensureGitHubWebhook((await context.params).id)
      } catch (error) {
        await query(
          'update projects set auto_deploy=$1,github_connection_id=$2,updated_at=now() where id=$3',
          [previous.auto_deploy, previous.github_connection_id, (await context.params).id]
        )
        throw error
      }
    }

    // Only regenerate Caddy when a routing field changed.
    const routingChanged = body.url !== undefined || body.port !== undefined
    if (routingChanged && updatedProject.url && updatedProject.port) {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy(updatedProject.url, updatedProject.port)
    }

    if (body.autoDeploy !== undefined) {
      await query(
        `insert into audit_logs (user_id, action, resource, details)
         values ($1, 'project_auto_deploy_updated', $2, $3)`,
        [user?.id, `project:${(await context.params).id}`, JSON.stringify({ enabled: body.autoDeploy, webhook: webhook ? { action: webhook.action, repository: webhook.repository } : null })]
      )
    }

    return NextResponse.json({
      ...updatedProject,
      auto_deploy_ready: updatedProject.auto_deploy ? (shouldEnsureWebhook ? !!webhook : true) : false,
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    // Get URL before deleting to remove from Caddy
    const { rows } = await query('select url from projects where id = $1', [(await context.params).id])
    const project = rows[0]

    await query('delete from projects where id = $1', [(await context.params).id])

    if (project?.url) {
      const { removeFromCaddy } = await import('@/lib/caddy')
      await removeFromCaddy(project.url)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
