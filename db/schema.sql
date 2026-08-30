create extension if not exists "pgcrypto";

do $$ begin
  create type user_role as enum ('admin', 'operator', 'viewer');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type deploy_status as enum ('queued', 'running', 'success', 'failed');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type project_environment as enum ('production', 'staging');
exception
  when duplicate_object then null;
end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text not null,
  password_hash text not null,
  role user_role not null default 'admin',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  repo_url text,
  default_branch text not null default 'main',
  project_type text not null default 'next',
  root_path text not null,
  install_cmd text,
  build_cmd text,
  deploy_script text,
  start_cmd text,
  runtime_versions jsonb not null default '{}'::jsonb,
  pm2_name text not null,
  port integer,
  url text,
  webhook_secret text,
  environment project_environment not null default 'production',
  production_id uuid references projects(id) on delete set null,
  auto_deploy boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists github_connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  account_login text not null,
  account_name text,
  avatar_url text,
  token_ciphertext text not null,
  token_last_four text not null,
  token_scopes text[] not null default '{}',
  last_validated_at timestamptz,
  last_error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table projects add column if not exists github_connection_id uuid references github_connections(id) on delete set null;
create index if not exists projects_github_connection_idx on projects (github_connection_id);

create table if not exists deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  status deploy_status not null default 'queued',
  trigger text default 'manual',
  branch text,
  commit_sha text,
  started_at timestamptz,
  finished_at timestamptz,
  log text
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  resource text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cron_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text unique not null,
  description text,
  language text not null default 'custom',
  schedule text not null,
  timezone text not null default 'UTC',
  command text not null,
  working_directory text not null,
  timeout_seconds integer not null default 300 check (timeout_seconds between 1 and 86400),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text not null default 'idle',
  last_exit_code integer,
  last_output text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cron_jobs_due_idx
  on cron_jobs (next_run_at)
  where enabled = true;

create index if not exists cron_jobs_project_idx
  on cron_jobs (project_id);

create table if not exists backup_schedules (
  id uuid primary key default gen_random_uuid(),
  database_name text unique not null,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  time_of_day text not null default '03:00',
  timezone text not null default 'UTC',
  day_of_week integer not null default 0 check (day_of_week between 0 and 6),
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  month_of_year integer not null default 1 check (month_of_year between 1 and 12),
  retention_count integer not null default 30 check (retention_count between 1 and 365),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text not null default 'idle',
  last_file text,
  last_error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backup_schedules_due_idx
  on backup_schedules (next_run_at)
  where enabled = true;

create table if not exists project_databases (
  project_id uuid primary key references projects(id) on delete cascade,
  database_name text unique not null,
  role_name text unique not null,
  password_ciphertext text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists data_connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  provider text not null check (provider in ('postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'redis')),
  host text not null,
  port integer not null check (port between 1 and 65535),
  username text,
  password_ciphertext text,
  tls_enabled boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  purpose text not null default 'shared_application',
  managed boolean not null default false,
  is_default boolean not null default false,
  provisioning_enabled boolean not null default true,
  last_status text not null default 'untested',
  last_error text,
  last_tested_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_data_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  connection_id uuid not null references data_connections(id) on delete restrict,
  name text not null,
  database_name text not null,
  username text,
  password_ciphertext text,
  env_prefix text not null,
  options jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name),
  unique (project_id, env_prefix)
);

create index if not exists project_data_services_project_idx on project_data_services (project_id);
create index if not exists project_data_services_connection_idx on project_data_services (connection_id);
create unique index if not exists data_connections_default_provider_idx on data_connections (provider) where is_default = true;

create table if not exists data_service_backup_schedules (
  id uuid primary key default gen_random_uuid(),
  service_id uuid unique not null references project_data_services(id) on delete cascade,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  time_of_day text not null default '03:00',
  timezone text not null default 'UTC',
  day_of_week integer not null default 0 check (day_of_week between 0 and 6),
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  month_of_year integer not null default 1 check (month_of_year between 1 and 12),
  retention_count integer not null default 30 check (retention_count between 1 and 365),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text not null default 'idle',
  last_file text,
  last_error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists data_service_backup_schedules_due_idx
  on data_service_backup_schedules (next_run_at)
  where enabled = true;

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

create table if not exists cloudflare_connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  token_ciphertext text not null,
  token_last_four text not null,
  token_status text not null default 'active',
  last_error text,
  last_validated_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_domains (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  hostname text unique not null,
  cloudflare_connection_id uuid references cloudflare_connections(id) on delete set null,
  cloudflare_zone_id text,
  cloudflare_record_id text,
  record_type text not null default 'A' check (record_type in ('A', 'AAAA', 'CNAME')),
  record_content text,
  proxied boolean not null default true,
  is_primary boolean not null default false,
  ssl_mode text check (ssl_mode in ('off', 'flexible', 'full', 'strict')),
  dns_status text not null default 'pending',
  ssl_status text not null default 'pending',
  last_error text,
  last_synced_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_domains_project_idx on project_domains (project_id);
create index if not exists project_domains_cloudflare_idx on project_domains (cloudflare_connection_id);
create unique index if not exists project_domains_one_primary_idx on project_domains (project_id) where is_primary = true;

create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  description text,
  command text not null,
  working_directory text not null,
  pm2_name text unique not null,
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

create table if not exists runtime_jobs (
  id uuid primary key default gen_random_uuid(),
  runtime_id text not null,
  action text not null check (action in ('install','update','configure','install-version')),
  requested_version text,
  status text not null default 'queued' check (status in ('queued','running','success','failed','interrupted')),
  log text not null default '',
  error text,
  requested_by uuid references users(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists runtime_jobs_created_idx on runtime_jobs (created_at desc);
create index if not exists runtime_jobs_active_idx on runtime_jobs (status) where status in ('queued','running');

create table if not exists runtime_update_status (
  runtime_id text primary key,
  current_version text,
  latest_version text,
  update_available boolean not null default false,
  checked_at timestamptz not null default now()
);
