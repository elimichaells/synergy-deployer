-- Every resource belongs to a server; removal drops control-plane records only.
create table if not exists remote_resources (
 server_id uuid primary key references managed_servers(id) on delete cascade,
 cleanup_enabled boolean not null default false, cleanup_last_at timestamptz,
 memory_alerts jsonb not null default '[]', uptime jsonb
);
create table if not exists remote_memory_samples (
 server_id uuid not null references managed_servers(id) on delete cascade,
 taken_at timestamptz not null, sample jsonb not null, primary key(server_id,taken_at)
);
alter table remote_jobs add column if not exists resource_action text;
alter table remote_jobs add column if not exists resource_target uuid;
create index if not exists remote_jobs_resources on remote_jobs(server_id,resource_action,created_at desc) where resource_action is not null;
create table if not exists remote_automations (
 id uuid primary key default gen_random_uuid(), server_id uuid not null references managed_servers(id) on delete cascade,
 kind text not null check(kind in ('cron','worker')), config jsonb not null,
 next_run_at timestamptz, last_job_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists remote_automations_server on remote_automations(server_id,kind);
alter table if exists manager_ai_events add column if not exists server_id uuid;
create table if not exists remote_recovery_reviews (
 id uuid primary key default gen_random_uuid(), server_id uuid not null references managed_servers(id) on delete cascade,
 app_id uuid not null, actor_id uuid not null, fingerprint text not null, status text not null default 'pending',
 expires_at timestamptz not null, created_at timestamptz not null default now(), job_id uuid
);
