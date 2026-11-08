-- Keep the existing console job kind so older Manager releases can read this queue.
alter table remote_jobs add column if not exists operation_type text;
create table if not exists remote_health (
  server_id uuid primary key references managed_servers(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  history jsonb not null default '{}'::jsonb
);
