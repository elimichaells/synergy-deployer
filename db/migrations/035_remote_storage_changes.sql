-- Retains encrypted proposed credentials until the agent's durable journal is
-- reconciled. A terminal transport failure is not proof of database rollback.
create table if not exists remote_storage_changes (
  id uuid primary key,
  server_id uuid not null references managed_servers(id) on delete cascade,
  service_id uuid not null,
  kind text not null check(kind in ('dedicated-user','move')),
  status text not null default 'reviewing',
  metadata_hash text not null,
  payload_ciphertext text not null,
  plan_private_ciphertext text,
  job_id uuid,
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists remote_storage_changes_pending on remote_storage_changes(server_id,status);
