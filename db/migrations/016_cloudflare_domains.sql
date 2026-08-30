create table if not exists cloudflare_connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  token_ciphertext text not null,
  token_last_four text not null,
  token_status text not null default 'active',
  last_error text,
  last_validated_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_domains (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  hostname text unique not null,
  cloudflare_connection_id uuid references cloudflare_connections(id) on delete set null,
  cloudflare_zone_id text,
  cloudflare_record_id text,
  record_type text not null default 'A' check (record_type in ('A', 'AAAA', 'CNAME')),
  record_content text,
  proxied boolean not null default true,
  is_primary boolean not null default false,
  ssl_mode text check (ssl_mode in ('off', 'flexible', 'full', 'strict')),
  dns_status text not null default 'pending',
  ssl_status text not null default 'pending',
  last_error text,
  last_synced_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_domains_project_idx on project_domains (project_id);
create index if not exists project_domains_cloudflare_idx on project_domains (cloudflare_connection_id);
create unique index if not exists project_domains_one_primary_idx on project_domains (project_id) where is_primary = true;
