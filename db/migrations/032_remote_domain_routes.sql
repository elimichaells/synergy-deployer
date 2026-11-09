create table if not exists remote_domain_routes (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  domain_id uuid not null references remote_domains(id) on delete cascade,
  project_id uuid not null references remote_apps(id) on delete restrict,
  path_prefix text not null,
  strip_prefix boolean not null default false,
  deleting boolean not null default false,
  created_at timestamptz not null default now(),
  unique(domain_id,path_prefix)
);
