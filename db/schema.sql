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
