-- Retain the one-active-job-per-application constraint. Additional authenticated
-- pushes wait here until the active release finishes or is cancelled.
create table if not exists remote_webhook_queue (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete cascade,
  app_id uuid not null,
  user_id uuid references users(id) on delete set null,
  payload_ciphertext text not null,
  trigger text not null default 'webhook' check(trigger='webhook'),
  branch text not null,
  repo_url text not null,
  requested_commit text not null,
  promotion_options jsonb,
  created_at timestamptz not null default now(),
  foreign key(app_id,server_id) references remote_apps(id,server_id) on delete cascade,
  unique(app_id,repo_url,branch,requested_commit)
);
create index if not exists remote_webhook_queue_order on remote_webhook_queue(server_id,app_id,created_at,id);

-- Read-only history includes waiting pushes without making them claimable jobs.
create or replace view remote_job_history as
  select * from remote_jobs
  union all
  select (jsonb_populate_record(null::remote_jobs,to_jsonb(q)||jsonb_build_object(
    'kind','deploy','status','queued','log','Waiting for the current deployment to finish.',
    'updated_at',q.created_at,'cancel_requested',false,'report_sequence',0))).*
  from remote_webhook_queue q;
