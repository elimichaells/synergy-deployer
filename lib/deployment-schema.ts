import { query } from '@/lib/db'

let schema: Promise<void> | undefined
export function ensureDeploymentSchema() {
  return schema ??= query(`
    alter table deployments add column if not exists phase text not null default 'pending';
    alter table deployments add column if not exists security_status text not null default 'pending';
    alter table deployments add column if not exists release_path text;
    alter table deployments add column if not exists build_changes jsonb;
    alter table projects add column if not exists security_gate_off_until timestamptz;
    alter table projects add column if not exists memory_limit_mb integer;
    alter table projects add column if not exists start_method text;
    create table if not exists database_moves (
      id uuid primary key default gen_random_uuid(),
      service_id text not null, database_name text not null, target_database text,
      source_connection_id uuid, target_connection_id uuid, role_name text,
      status text not null default 'running', log text not null default '', error text, copy_path text,
      created_by uuid, started_at timestamptz not null default now(), finished_at timestamptz);
    alter table database_moves add column if not exists project_ids uuid[] not null default array[]::uuid[];
    alter table projects add column if not exists security_gate_off_reason text;
    alter table projects add column if not exists security_gate_off_by uuid;
    alter table projects add column if not exists security_gate_off_at timestamptz;
    alter table projects add column if not exists active_deployment_id uuid references deployments(id) on delete set null;
    update projects p set active_deployment_id=(select id from deployments d where d.project_id=p.id and d.status='success' order by d.finished_at desc nulls last limit 1)
    where active_deployment_id is null;
  `).then(() => {}).catch(error => { schema = undefined; throw error })
}
