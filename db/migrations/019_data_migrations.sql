create table if not exists data_migration_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_service_id uuid not null references project_data_services(id) on delete restrict,
  target_service_id uuid not null references project_data_services(id) on delete restrict,
  status text not null default 'queued' check (status in ('queued','running','validating','succeeded','failed','cancelled','interrupted','activated')),
  preserve_schema boolean not null default true,
  replace_target boolean not null default false,
  table_map jsonb not null default '[]'::jsonb,
  validation jsonb,
  log text not null default '',
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  activated_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_service_id <> target_service_id)
);

create index if not exists data_migration_jobs_project_idx on data_migration_jobs (project_id,created_at desc);
create index if not exists data_migration_jobs_active_idx on data_migration_jobs (status) where status in ('queued','running','validating');
