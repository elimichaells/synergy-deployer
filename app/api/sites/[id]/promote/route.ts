import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { startDeploy, type DeployProject } from '@/lib/deploy'
import { getPromotionPlan } from '@/lib/promotion'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

/** What promoting this staging app would release, shown before the person confirms. */
export async function GET(_: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ plan: await getPromotionPlan((await context.params).id) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

/**
 * Promotes the exact commit staging is running. The caller sends the commit it was shown, so a
 * promotion can never release something different from what was confirmed.
 */
export async function POST(request: Request, context: Context) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const stagingId = (await context.params).id
    const body = await request.json().catch(() => ({}))
    const plan = await getPromotionPlan(stagingId)
    if (plan.blocker) throw new ApiError(plan.blocker, 409)
    const commit = plan.staging.commit!
    if (typeof body?.commit !== 'string' || body.commit !== commit) {
      throw new ApiError('Staging changed since you opened this. Review what will be released and confirm again.', 409)
    }

    const { rows } = await query<DeployProject>(
      `SELECT id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, github_connection_id
       FROM projects WHERE id = $1`,
      [plan.production.id]
    )
    const production = rows[0]
    if (!production) throw new ApiError('Linked production app not found', 404)

    // Separate branches: merge the tested commit into the production branch.
    // Shared branch: move production to exactly the tested commit.
    const deploymentId = await startDeploy(production, plan.mode === 'merge'
      ? { userId: user?.id, trigger: 'promote', mergeBranch: plan.staging.branch, mergeCommit: commit }
      : { userId: user?.id, trigger: 'promote', commitSha: commit })
    if (!deploymentId) throw new ApiError('A deployment is already running for the production app', 409)

    await audit(user?.id, 'deployment.promoted', `project:${plan.production.id}`, { from: plan.staging.name, commit, mode: plan.mode, commits: plan.commits.length })
    return NextResponse.json({ deploymentId, productionId: plan.production.id, status: 'running', commit, mergedBranch: plan.mode === 'merge' ? plan.staging.branch : null })
  } catch (error) { return jsonError(error) }
}
