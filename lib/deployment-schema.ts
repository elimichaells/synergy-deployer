import { query } from '@/lib/db'

let schema: Promise<void> | undefined
export function ensureDeploymentSchema() {
  return schema ??= query(`
    alter table deployments add column if not exists phase text not null default 'pending';
    alter table deployments add column if not exists security_status text not null default 'pending';
    alter table deployments add column if not exists release_path text;
    alter table projects add column if not exists active_deployment_id uuid references deployments(id) on delete set null;
    update projects p set active_deployment_id=(select id from deployments d where d.project_id=p.id and d.status='success' order by d.finished_at desc nulls last limit 1)
    where active_deployment_id is null;
  `).then(() => {}).catch(error => { schema = undefined; throw error })
}
