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
  start_cmd text,
  pm2_name text not null,
  port integer,
  url text,
  webhook_secret text,
  environment project_environment not null default 'production',
  production_id uuid references projects(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
