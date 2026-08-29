create table if not exists github_connections (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  account_login text not null,
  account_name text,
  avatar_url text,
  token_ciphertext text not null,
  token_last_four text not null,
  token_scopes text[] not null default '{}',
  last_validated_at timestamptz,
  last_error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table projects add column if not exists github_connection_id uuid references github_connections(id) on delete set null;
create index if not exists projects_github_connection_idx on projects (github_connection_id);
