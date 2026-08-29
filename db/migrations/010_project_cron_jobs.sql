alter table cron_jobs
  add column if not exists project_id uuid references projects(id) on delete cascade;

alter table cron_jobs
  add column if not exists language text not null default 'custom';

create index if not exists cron_jobs_project_idx
  on cron_jobs (project_id);
