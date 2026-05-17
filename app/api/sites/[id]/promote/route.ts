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

    const stagingId = context.params.id

    // 1. Get the staging project and verify it's a staging environment
    const { rows: stagingRows } = await query<DeployProject & { environment: string; production_id: string }>(
      `SELECT id, name, environment, production_id, default_branch
       FROM projects WHERE id = $1`,
      [stagingId]
    )

    const staging = stagingRows[0]
    if (!staging) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (staging.environment !== 'staging') {
      return NextResponse.json({ error: 'Only staging sites can be promoted' }, { status: 400 })
    }
    if (!staging.production_id) {
      return NextResponse.json({ error: 'No linked production site found' }, { status: 400 })
    }

    // 2. Get the staging branch name (the branch to merge FROM)
    const stagingBranch = staging.default_branch || 'dev'

    // 3. Verify staging has at least one successful deployment
    const { rows: deployRows } = await query<{ id: string }>(
      `SELECT id FROM deployments
       WHERE project_id = $1 AND status = 'success'
       ORDER BY finished_at DESC LIMIT 1`,
      [stagingId]
    )

    if (deployRows.length === 0) {
      return NextResponse.json(
        { error: 'No successful staging deployment found. Deploy to staging first.' },
        { status: 400 }
      )
    }

    // 4. Get the production project
    const { rows: prodRows } = await query<DeployProject>(
      `SELECT id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pm2_name, port
       FROM projects WHERE id = $1`,
      [staging.production_id]
    )

    const production = prodRows[0]
    if (!production) {
      return NextResponse.json({ error: 'Linked production project not found' }, { status: 404 })
    }

    // 5. Deploy by merging staging branch into production branch (async)
    const deploymentId = await startDeploy(production, {
      userId: user?.id,
      trigger: 'promote',
      mergeBranch: stagingBranch,
    })

    if (!deploymentId) {
      return NextResponse.json({ error: 'Deploy already running for production project' }, { status: 409 })
    }

    return NextResponse.json({
      deploymentId,
      productionId: staging.production_id,
      status: 'running',
      mergedBranch: stagingBranch,
    })
  } catch (error) {
    return jsonError(error)
  }
}
