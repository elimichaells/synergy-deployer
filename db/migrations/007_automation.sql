create table if not exists cron_jobs (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  description text,
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
