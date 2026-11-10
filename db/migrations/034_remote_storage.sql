create unique index if not exists remote_apps_id_server_idx on remote_apps(id,server_id);
create table if not exists removed_application_records (
  id uuid primary key default gen_random_uuid(),application_id uuid not null,server_id uuid,
  name text not null,record_ciphertext text not null,removed_by uuid references users(id) on delete set null,
  removed_at timestamptz not null default now()
);
create table if not exists remote_storage_connections (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  name text not null,
  provider text not null check(provider in ('postgresql','mysql','mariadb','sqlserver','mongodb','redis')),
  host text not null,
  port integer not null check(port between 1 and 65535),
  username text,
  password_ciphertext text,
  tls_enabled boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  purpose text not null default 'shared_application',
  managed boolean not null default false,
  is_default boolean not null default false,
  provisioning_enabled boolean not null default false,
  last_status text not null default 'untested',
  last_error text,
  last_tested_at timestamptz,
  source_operation_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,server_id),unique(server_id,name),unique(source_operation_id)
);
create unique index if not exists remote_storage_connection_default_idx on remote_storage_connections(server_id,provider) where is_default;
create table if not exists remote_storage_services (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  app_id uuid not null,
  connection_id uuid not null,
  name text not null,
  database_name text not null,
  username text,
  password_ciphertext text,
  env_prefix text not null,
  application_primary boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  legacy_app_id uuid unique,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(app_id,server_id) references remote_apps(id,server_id) on delete cascade,
  foreign key(connection_id,server_id) references remote_storage_connections(id,server_id),
  unique(id,server_id),unique(app_id,name),unique(app_id,env_prefix)
);
create unique index if not exists remote_storage_service_primary_idx on remote_storage_services(app_id) where application_primary;
create table if not exists remote_storage_schedules (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  service_id uuid not null unique,
  config jsonb not null,
  next_run_at timestamptz,
  last_job_id uuid,
  last_status text not null default 'idle',
  last_finished_at timestamptz,
  foreign key(service_id,server_id) references remote_storage_services(id,server_id) on delete cascade
);
alter table remote_jobs add column if not exists result_private_ciphertext text;
alter table remote_apps add column if not exists storage_catalog_enabled boolean not null default false;
alter table remote_storage_services add column if not exists pending_password_ciphertext text;
create table if not exists remote_storage_renames (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  connection_id uuid not null,
  service_id text not null,
  old_name text not null,new_name text not null,
  apps jsonb not null,service_ids jsonb not null,
  status text not null default 'running',error text,
  job_id uuid,created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),finished_at timestamptz
);
