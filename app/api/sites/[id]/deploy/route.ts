import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { startDeploy, type DeployProject } from '@/lib/deploy'

export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const { rows: projectRows } = await query<DeployProject>(
      `SELECT id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pre_deploy_cmd, post_deploy_cmd, pm2_name, port
       FROM projects WHERE id = $1`,
      [context.params.id]
    )

    const project = projectRows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Start deployment asynchronously so the client gets the deploymentId immediately
    // and can stream logs in real-time
    const deploymentId = await startDeploy(project, { userId: user?.id, trigger: 'manual' })

    if (!deploymentId) {
      return NextResponse.json({ error: 'Deploy already running for this project' }, { status: 409 })
    }

    return NextResponse.json({ deploymentId, status: 'running' })
  } catch (error) {
    return jsonError(error)
  }
}
