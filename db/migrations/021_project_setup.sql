create table if not exists project_setup (
  project_id uuid primary key references projects(id) on delete cascade,
  step text not null default 'repository',
  decisions jsonb not null default '{}',
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
