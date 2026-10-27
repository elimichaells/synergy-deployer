-- Existing deployments remain valid; only new guided imports require setup.
alter table remote_apps add column if not exists environment_name text not null default 'production' check (environment_name in ('production','staging'));
alter table remote_apps add column if not exists production_id uuid references remote_apps(id) on delete restrict;
alter table remote_apps add column if not exists project_type text;
alter table remote_apps add column if not exists guided_setup boolean not null default false;
alter table remote_apps add column if not exists setup_step text not null default 'repository';
alter table remote_apps add column if not exists setup_decisions jsonb not null default '{}';
alter table remote_apps add column if not exists inspection jsonb;
alter table remote_apps add column if not exists setup_completed_at timestamptz;
alter table remote_apps add column if not exists database_config jsonb;
alter table remote_apps add column if not exists database_ciphertext text;
alter table remote_jobs add column if not exists kind text not null default 'deploy' check (kind in ('deploy','inspect','database','validate'));
alter table remote_jobs add column if not exists result jsonb;
create unique index if not exists remote_app_staging_pair on remote_apps(production_id) where production_id is not null;
