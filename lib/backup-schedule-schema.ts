import { query } from '@/lib/db'

let schemaPromise: Promise<void> | null = null

export function ensureBackupScheduleSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      create table if not exists backup_schedules (
        id uuid primary key default gen_random_uuid(),
        database_name text unique not null,
        frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
        time_of_day text not null default '03:00',
        timezone text not null default 'UTC',
        day_of_week integer not null default 0 check (day_of_week between 0 and 6),
        day_of_month integer not null default 1 check (day_of_month between 1 and 28),
        month_of_year integer not null default 1 check (month_of_year between 1 and 12),
        retention_count integer not null default 30 check (retention_count between 1 and 365),
        enabled boolean not null default true,
        next_run_at timestamptz,
        last_started_at timestamptz,
        last_finished_at timestamptz,
        last_status text not null default 'idle',
        last_file text,
        last_error text,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `).then(async () => {
      await query('create index if not exists backup_schedules_due_idx on backup_schedules (next_run_at) where enabled = true')
    }).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}
