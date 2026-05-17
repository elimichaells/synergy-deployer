-- Staging/Production environment support

do $$ begin
  create type project_environment as enum ('production', 'staging');
exception
  when duplicate_object then null;
end $$;

-- Add environment column (all existing projects are production)
alter table projects
  add column if not exists environment project_environment not null default 'production';

-- Staging sites reference their production counterpart
alter table projects
  add column if not exists production_id uuid references projects(id) on delete set null;
