create table if not exists project_databases (
  project_id uuid primary key references projects(id) on delete cascade,
  database_name text unique not null,
  role_name text unique not null,
  password_ciphertext text not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
