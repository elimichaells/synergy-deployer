import { query } from '@/lib/db'

let schemaPromise: Promise<void> | null = null

export function ensureAutomationSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await query(`
        create table if not exists cron_jobs (
          id uuid primary key default gen_random_uuid(),
          project_id uuid references projects(id) on delete cascade,
          name text unique not null,
          description text,
          language text not null default 'custom',
          schedule text not null,
          timezone text not null default 'UTC',
          command text not null,
          working_directory text not null,
          timeout_seconds integer not null default 300 check (timeout_seconds between 1 and 86400),
          enabled boolean not null default true,
          next_run_at timestamptz,
          last_started_at timestamptz,
          last_finished_at timestamptz,
          last_status text not null default 'idle',
          last_exit_code integer,
          last_output text,
          created_by uuid references users(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      await query('alter table cron_jobs add column if not exists project_id uuid references projects(id) on delete cascade')
      await query("alter table cron_jobs add column if not exists language text not null default 'custom'")
      await query('create index if not exists cron_jobs_due_idx on cron_jobs (next_run_at) where enabled = true')
      await query('create index if not exists cron_jobs_project_idx on cron_jobs (project_id)')
      await query(`
        create table if not exists workers (
          id uuid primary key default gen_random_uuid(),
          name text unique not null,
          description text,
          command text not null,
          working_directory text not null,
          pm2_name text unique not null,
          enabled boolean not null default true,
          created_by uuid references users(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
    })().catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}
