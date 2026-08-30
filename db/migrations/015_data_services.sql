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
