import { query } from '@/lib/db'
import { ApiError } from '@/lib/api'

let schema: Promise<void> | undefined

export function ensureProjectPinsSchema() {
  return schema ??= query(`
    create table if not exists project_pins (
      user_id uuid not null references users(id) on delete cascade,
      project_id uuid not null references projects(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (user_id, project_id)
    );
    create index if not exists project_pins_user_created_idx on project_pins(user_id, created_at desc);
  `).then(() => undefined).catch(error => { schema = undefined; throw error })
}

export async function setProjectPinned(userId: string, projectId: string, pinned: boolean) {
  await ensureProjectPinsSchema()
  const project = await query<{ id: string }>('select id from projects where id=$1', [projectId])
  if (!project.rows[0]) throw new ApiError('Application not found', 404)
  if (pinned) await query('insert into project_pins(user_id,project_id) values($1,$2) on conflict do nothing', [userId, projectId])
  else await query('delete from project_pins where user_id=$1 and project_id=$2', [userId, projectId])
  return pinned
}
