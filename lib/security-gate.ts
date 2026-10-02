import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { ApiError } from '@/lib/api'
import { ensureDeploymentSchema } from '@/lib/deployment-schema'
import { getPromotionPlan } from '@/lib/promotion'
import { gateOffUntil, type GateScope } from '@/lib/security-gate-policy'
import type { DeployOptions, DeployProject } from '@/lib/deploy'

/** Whether an app's dependency security gate is switched off, and who decided that. */
export interface GateState {
  off: boolean
  /** Off until someone turns it back on, rather than until a date. */
  indefinite: boolean
  until: string | null
  reason: string | null
  by: string | null
  at: string | null
}

export async function getGateState(projectId: string): Promise<GateState | null> {
  await ensureDeploymentSchema()
  const { rows } = await query<GateState>(
    `select coalesce(p.security_gate_off_until > now(), false) as off,
            coalesce(p.security_gate_off_until = 'infinity', false) as indefinite,
            case when p.security_gate_off_until = 'infinity' then null
                 else to_char(p.security_gate_off_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end as until,
            p.security_gate_off_reason as reason, u.name as by,
            to_char(p.security_gate_off_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at
     from projects p left join users u on u.id = p.security_gate_off_by where p.id = $1`, [projectId])
  const state = rows[0]
  if (!state) return null
  // An override that has run out is the same as no override.
  return state.off ? state : { off: false, indefinite: false, until: null, reason: null, by: null, at: null }
}

export async function turnGateOff(projectId: string, userId: string | null | undefined, scope: Exclude<GateScope, 'once'>, reason: string) {
  await ensureDeploymentSchema()
  const { rowCount } = await query(
    `update projects set security_gate_off_until = $2::timestamptz, security_gate_off_reason = $3, security_gate_off_by = $4, security_gate_off_at = now() where id = $1`,
    [projectId, gateOffUntil(scope), reason, userId || null])
  if (!rowCount) throw new ApiError('Application not found', 404)
  await audit(userId, 'security_gate.turned_off', `project:${projectId}`, { scope, reason })
}

export async function turnGateOn(projectId: string, userId: string | null | undefined) {
  await ensureDeploymentSchema()
  const { rowCount } = await query(
    `update projects set security_gate_off_until = null, security_gate_off_reason = null, security_gate_off_by = null, security_gate_off_at = null where id = $1`, [projectId])
  if (!rowCount) throw new ApiError('Application not found', 404)
  await audit(userId, 'security_gate.turned_on', `project:${projectId}`)
}

/** What "deploy anyway" would do for a deployment the gate stopped. */
export interface OverridePlan {
  projectId: string
  projectName: string
  branch: string
  /** A plain deployment of the branch, or a re-run of the promotion that was stopped. */
  kind: 'deploy' | 'promote'
  staging: { id: string; name: string; branch: string; commit: string } | null
  blocker: string | null
}

const PROJECT_COLUMNS = 'id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, github_connection_id'

export async function getOverridePlan(deploymentId: string): Promise<OverridePlan> {
  await ensureDeploymentSchema()
  const { rows } = await query<{ project_id: string; project_name: string; branch: string; status: string; security_status: string; trigger: string; newest: boolean }>(
    `select d.project_id, p.name as project_name, coalesce(p.default_branch, 'main') as branch, d.status, d.security_status, d.trigger,
            not exists (select 1 from deployments n where n.project_id = d.project_id and n.started_at > d.started_at) as newest
     from deployments d join projects p on p.id = d.project_id where d.id = $1`, [deploymentId])
  const deployment = rows[0]
  if (!deployment) throw new ApiError('Deployment not found', 404)
  const plan: OverridePlan = { projectId: deployment.project_id, projectName: deployment.project_name, branch: deployment.branch, kind: 'deploy', staging: null, blocker: null }
  if (deployment.status !== 'failed' || deployment.security_status !== 'failed') return { ...plan, blocker: 'This deployment was not stopped by the security gate.' }
  if (!deployment.newest) return { ...plan, blocker: 'A newer deployment exists for this app. Open the newest one instead.' }
  if (deployment.trigger !== 'promote') return plan

  // The stopped release was a promotion, so "deploy anyway" must release what staging runs, not just the production branch.
  const staging = await query<{ id: string }>('select id from projects where production_id = $1 order by created_at limit 2', [deployment.project_id])
  if (staging.rows.length !== 1) return plan
  const promotion = await getPromotionPlan(staging.rows[0].id)
  if (promotion.blocker || !promotion.staging.commit) return { ...plan, kind: 'promote', blocker: promotion.blocker || 'Deploy staging first, then promote again.' }
  return { ...plan, kind: 'promote', staging: { id: promotion.staging.id, name: promotion.staging.name, branch: promotion.staging.branch, commit: promotion.staging.commit } }
}

/** The project row and options to start the release an override plan describes. */
export async function overrideDeployment(plan: OverridePlan, userId: string | null | undefined, reason: string): Promise<{ project: DeployProject; options: DeployOptions }> {
  const { rows } = await query<DeployProject>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [plan.projectId])
  if (!rows[0]) throw new ApiError('Application not found', 404)
  const base = { userId, acceptSecurityRisk: { reason } }
  if (plan.kind !== 'promote' || !plan.staging) return { project: rows[0], options: { ...base, trigger: 'manual' } }
  return { project: rows[0], options: plan.staging.branch !== plan.branch
    ? { ...base, trigger: 'promote', mergeBranch: plan.staging.branch, mergeCommit: plan.staging.commit }
    : { ...base, trigger: 'promote', commitSha: plan.staging.commit } }
}
