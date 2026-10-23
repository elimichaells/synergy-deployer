-- Remote execution has separate records: local-only APIs must never act on a remote app.
create table if not exists managed_servers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text not null default '',
  platform text not null check (platform in ('win32','linux')),
  enabled boolean not null default true,
  enrollment_hash text,
  enrollment_expires_at timestamptz,
  agent_hash text unique,
  enrolled_at timestamptz,
  last_seen_at timestamptz,
  metrics jsonb,
  ca_pem text,
  created_at timestamptz not null default now()
);
create table if not exists remote_apps (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete restrict,
  name text not null,
  repo_url text not null,
  branch text not null default 'main',
  install_cmd text not null default '',
  build_cmd text not null default '',
  start_cmd text not null,
  port integer not null check (port between 1024 and 65535),
  health_path text not null default '/',
  access_mode text not null check (access_mode in ('lan','wan')),
  hostname text not null,
  ip_address text not null default '',
  ip_port integer,
  git_connection_id uuid references github_connections(id) on delete restrict,
  env_ciphertext text not null,
  env_names text[] not null default '{}',
  live_commit text,
  deployed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(server_id,hostname),
  unique(server_id,port),
  unique(server_id,ip_port)
);
create table if not exists remote_jobs (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete restrict,
  app_id uuid not null references remote_apps(id) on delete restrict,
  user_id uuid references users(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','success','failed','cancelled')),
  payload_ciphertext text,
  claim_token text,
  report_sequence bigint not null default 0,
  log text not null default '',
  commit_sha text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists remote_job_app_active on remote_jobs(app_id) where status in ('queued','running');
create unique index if not exists remote_job_server_running on remote_jobs(server_id) where status='running';
create index if not exists remote_jobs_server_created on remote_jobs(server_id,created_at desc);
