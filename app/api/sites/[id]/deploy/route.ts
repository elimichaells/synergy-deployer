import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { startDeploy, type DeployProject } from '@/lib/deploy'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const text = await request.text()
    let options: { preflight?: boolean; healthCheck?: boolean } = {}
    if (text.trim()) {
      try { options = JSON.parse(text) } catch {
        return NextResponse.json({ error: 'Invalid deployment options' }, { status: 400 })
      }
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
        (options.preflight !== undefined && typeof options.preflight !== 'boolean') ||
        (options.healthCheck !== undefined && typeof options.healthCheck !== 'boolean')) {
        return NextResponse.json({ error: 'Preflight and healthCheck must be booleans' }, { status: 400 })
      }
    }

    const { rows: projectRows } = await query<DeployProject>(
      `SELECT id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, github_connection_id
       FROM projects WHERE id = $1`,
      [(await context.params).id]
    )

    const project = projectRows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Start deployment asynchronously so the client gets the deploymentId immediately
    // and can stream logs in real-time
    const deploymentId = await startDeploy(project, { userId: user?.id, trigger: 'manual', preflight: options.preflight, healthCheck: options.healthCheck })

    if (!deploymentId) {
      return NextResponse.json({ error: 'Deploy already running for this project' }, { status: 409 })
    }

    return NextResponse.json({ deploymentId, status: 'running' })
  } catch (error) {
    return jsonError(error)
  }
}
