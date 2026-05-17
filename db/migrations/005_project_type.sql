alter table projects
  add column if not exists project_type text not null default 'next';
