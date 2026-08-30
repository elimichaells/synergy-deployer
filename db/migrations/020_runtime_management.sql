alter table projects add column if not exists runtime_versions jsonb not null default '{}'::jsonb;

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
