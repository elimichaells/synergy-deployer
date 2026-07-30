import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { startDeploy, type DeployProject } from '@/lib/deploy'
import { audit } from '@/lib/audit'

export async function POST(_request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    // Load the deployment and its project in one go
    const { rows } = await query<DeployProject & {
      deployment_id: string
      deployment_status: string
      deployment_commit: string | null
      project_name: string
    }>(
      `select d.id as deployment_id, d.status as deployment_status, d.commit_sha as deployment_commit,
              p.id, p.name, p.name as project_name, p.repo_url, p.default_branch, p.project_type, p.root_path,
              p.install_cmd, p.build_cmd, p.start_cmd, p.pre_deploy_cmd, p.post_deploy_cmd, p.pm2_name, p.port
       from deployments d
       join projects p on p.id = d.project_id
       where d.id = $1`,
      [context.params.id]
    )

    const row = rows[0]
    if (!row) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }
    if (row.deployment_status !== 'success') {
      return NextResponse.json({ error: 'Only successful deployments can be rolled back to' }, { status: 400 })
    }
    if (!row.deployment_commit) {
      return NextResponse.json({ error: 'This deployment has no commit SHA recorded' }, { status: 400 })
    }
    if (!row.repo_url) {
      return NextResponse.json({ error: 'Project has no repository configured' }, { status: 400 })
    }

    const deploymentId = await startDeploy(row, {
      userId: user?.id,
      trigger: 'rollback',
      commitSha: row.deployment_commit,
    })

    if (!deploymentId) {
      return NextResponse.json({ error: 'A deployment is already running for this project' }, { status: 409 })
    }

    await audit(user?.id, 'deployment.rollback', row.project_name, {
      toCommit: row.deployment_commit,
      fromDeployment: context.params.id,
      newDeployment: deploymentId,
    })

    return NextResponse.json({ ok: true, deploymentId, commitSha: row.deployment_commit })
  } catch (error) {
    return jsonError(error)
  }
}
