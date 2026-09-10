create table if not exists application_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
alter table projects add column if not exists application_group_id uuid references application_groups(id) on delete set null;
alter table projects add column if not exists component_role text not null default 'application'
  check (component_role in ('application','frontend','backend','service'));
create index if not exists projects_application_group_idx on projects(application_group_id);
