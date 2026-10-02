import { existsSync } from 'fs'
import path from 'path'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { runCommand } from '@/lib/exec'
import { ensureDeploymentSchema } from '@/lib/deployment-schema'
import { compareGitHubCommits } from '@/lib/github-webhooks'
import { COMMIT_SHA, LOG_FORMAT, databaseChangeFiles, fromGitHubComparison, parseCommitLog, promotionBlocker, promotionMode, promotionWarnings, type PromotionFacts } from '@/lib/promotion-policy'

interface AppRow { id: string; name: string; environment: string; production_id: string | null; default_branch: string | null; root_path: string; auto_deploy: boolean; active_deployment_id: string | null }

const git = (cwd: string, ...args: string[]) => runCommand({ file: 'git', args }, cwd, 20_000, undefined, undefined, true)

/**
 * What promoting a staging app would release: the exact commit staging is running, the commits
 * production does not have yet, and anything worth knowing before confirming.
 */
export async function getPromotionPlan(stagingId: string) {
  await ensureDeploymentSchema()
  const { rows: stagingRows } = await query<AppRow>('select id,name,environment,production_id,default_branch,root_path,auto_deploy,active_deployment_id from projects where id=$1', [stagingId])
  const staging = stagingRows[0]
  if (!staging) throw new ApiError('App not found', 404)
  if (staging.environment !== 'staging') throw new ApiError('Only a staging app can be promoted', 400)
  if (!staging.production_id) throw new ApiError('This staging app is not linked to a production app', 400)
  const { rows: productionRows } = await query<AppRow>('select id,name,environment,production_id,default_branch,root_path,auto_deploy,active_deployment_id from projects where id=$1', [staging.production_id])
  const production = productionRows[0]
  if (!production) throw new ApiError('Linked production app not found', 404)

  const commitOf = async (deploymentId: string | null) => deploymentId
    ? (await query<{ commit_sha: string | null }>('select commit_sha from deployments where id=$1', [deploymentId])).rows[0]?.commit_sha || null : null
  const stagingSha = await commitOf(staging.active_deployment_id)
  const productionSha = await commitOf(production.active_deployment_id)
  const latest = (await query<{ status: string; commit_sha: string | null }>('select status,commit_sha from deployments where project_id=$1 order by started_at desc nulls last limit 1', [staging.id])).rows[0]

  const stagingBranch = staging.default_branch || 'main'
  const productionBranch = production.default_branch || 'main'
  const facts: PromotionFacts = {
    stagingSha: stagingSha && COMMIT_SHA.test(stagingSha) ? stagingSha : null,
    productionSha: productionSha && COMMIT_SHA.test(productionSha) ? productionSha : null,
    latestStagingStatus: latest?.status || null, latestStagingSha: latest?.commit_sha || null,
    alreadyIncluded: false, historyKnown: false, commits: [], databaseFiles: [],
  }

  // The staging checkout has the staging commit, and normally the production commit as an ancestor.
  if (facts.stagingSha && facts.productionSha && facts.stagingSha !== facts.productionSha && existsSync(path.join(staging.root_path, '.git'))) {
    const known = await git(staging.root_path, 'cat-file', '-e', `${facts.productionSha}^{commit}`)
    const present = await git(staging.root_path, 'cat-file', '-e', `${facts.stagingSha}^{commit}`)
    if (known.code === 0 && present.code === 0) {
      facts.alreadyIncluded = (await git(staging.root_path, 'merge-base', '--is-ancestor', facts.stagingSha, facts.productionSha)).code === 0
      const log = await git(staging.root_path, 'log', '--no-color', '--date=short', `--format=${LOG_FORMAT}`, '-n', '50', `${facts.productionSha}..${facts.stagingSha}`)
      const files = await git(staging.root_path, 'diff', '--name-only', facts.productionSha, facts.stagingSha)
      if (log.code === 0 && files.code === 0) {
        facts.historyKnown = true
        facts.commits = parseCommitLog(log.output)
        facts.databaseFiles = databaseChangeFiles(files.output.split(/\r?\n/).filter(Boolean))
      }
    }
  }

  // The staging checkout often lacks the commit production runs (for example an earlier promotion's
  // merge commit, or when staging is behind). GitHub can compare the two without touching any checkout.
  if (!facts.historyKnown && facts.stagingSha && facts.productionSha && facts.stagingSha !== facts.productionSha) {
    const comparison = fromGitHubComparison(await compareGitHubCommits(production.id, facts.productionSha, facts.stagingSha))
    if (comparison) {
      facts.historyKnown = true
      facts.alreadyIncluded = comparison.alreadyIncluded
      facts.commits = comparison.commits
      facts.databaseFiles = databaseChangeFiles(comparison.files)
    }
  }

  return {
    staging: { id: staging.id, name: staging.name, branch: stagingBranch, commit: facts.stagingSha },
    production: { id: production.id, name: production.name, branch: productionBranch, commit: facts.productionSha, autoDeploy: production.auto_deploy },
    mode: promotionMode(stagingBranch, productionBranch),
    commits: facts.commits, historyKnown: facts.historyKnown, databaseFiles: facts.databaseFiles.slice(0, 20),
    blocker: promotionBlocker(facts), warnings: promotionWarnings(facts),
  }
}
