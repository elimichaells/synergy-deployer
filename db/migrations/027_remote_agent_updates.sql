-- Updates have their own durable queue. They never masquerade as application jobs.
create table if not exists remote_agent_updates (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references managed_servers(id) on delete restrict,
  user_id uuid references users(id) on delete set null,
  from_version text not null,
  target_version text not null,
  sha256 text not null,
  source text,
  status text not null default 'queued' check (status in ('queued','installing','success','rolled_back','failed','cancelled','recovery_required')),
  claim_token text,
  report_sequence bigint not null default 0,
  message text not null default 'Waiting for the agent to become idle',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists remote_agent_update_active on remote_agent_updates(server_id)
  where status in ('queued','installing','recovery_required');
create index if not exists remote_agent_update_history on remote_agent_updates(server_id,created_at desc);
