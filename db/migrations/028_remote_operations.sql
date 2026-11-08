-- Server console operations share the same serialized queue as application work.
alter table remote_apps add column if not exists runtime_versions jsonb not null default '{}'::jsonb;
alter table remote_jobs alter column app_id drop not null;
alter table remote_jobs drop constraint if exists remote_jobs_kind_check;
alter table remote_jobs add constraint remote_jobs_kind_check check (kind in ('deploy','inspect','database','validate','console','logs'));
alter table remote_jobs add column if not exists cancel_requested boolean not null default false;
create unique index if not exists remote_console_server_active on remote_jobs(server_id) where kind in ('console','logs') and status in ('queued','running');

create table if not exists remote_service_operations (
  id uuid primary key,
  server_id uuid not null references managed_servers(id) on delete restrict,
  user_id uuid references users(id) on delete set null,
  service_id text not null,
  status text not null check(status in ('running','success','failed','interrupted')),
  plan jsonb not null,
  result jsonb,
  log text not null default '',
  credentials_ciphertext text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists remote_service_active on remote_service_operations(server_id) where status in ('running','interrupted');
