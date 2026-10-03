import { query } from '@/lib/db'
import { directStartPlan, type DeployProject } from '@/lib/deploy'
import type { MemorySnapshot } from '@/lib/server-memory'

export interface StartMethodRow {
  projectId: string
  label: string
  environment: string | null
  /** 'direct': already switched. 'eligible': can switch. 'runner': must keep the runner, see `reason`. */
  state: 'direct' | 'eligible' | 'runner'
  /** Memory used by the processes that only start the app (runner, shells, npm). */
  overheadMb: number
  reason: string | null
}

/** Every running app started through the runner, or switched away from it, with what switching would save. */
export async function startMethodOverview(snapshot: MemorySnapshot): Promise<StartMethodRow[]> {
  const { rows } = await query<DeployProject & { environment: string | null }>(
    `select id, name, environment, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd,
            pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, github_connection_id, start_method from projects order by name`)
  const out: StartMethodRow[] = []
  for (const project of rows) {
    const app = snapshot.apps.find(item => item.name === project.pm2_name)
    if (!app) continue
    const base = { projectId: project.id, label: project.name, environment: project.environment, overheadMb: app.overheadMb }
    if (!app.runner) {
      if (project.start_method === 'direct') out.push({ ...base, state: 'direct', reason: null })
      continue
    }
    const plan = directStartPlan(project, project.root_path)
    out.push({ ...base, state: plan.direct ? 'eligible' : 'runner', reason: plan.reason })
  }
  return out.sort((a, b) => b.overheadMb - a.overheadMb)
}
