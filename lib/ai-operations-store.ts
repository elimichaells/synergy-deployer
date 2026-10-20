import { db, query } from '@/lib/db'
import { encryptSecret, decryptSecret } from '@/lib/secret-crypto'
import { ApiError } from '@/lib/api'

export const AI_SCHEMA = `
create table if not exists manager_ai_settings (
 id integer primary key check(id=1), enabled boolean not null default false,
 model text not null default '', key_ciphertext text, recovery_enabled boolean not null default true,
 updated_at timestamptz not null default now()
);
create table if not exists manager_ai_events (
 id uuid primary key, kind text not null, actor_id uuid, project_id uuid,
 status text not null, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index if not exists manager_ai_events_created on manager_ai_events(created_at desc);
create index if not exists manager_ai_events_project on manager_ai_events(project_id,created_at desc);
create table if not exists manager_ai_reviews (
 id uuid primary key, actor_id uuid not null, project_id uuid not null,
 fingerprint text not null, status text not null default 'pending',
 created_at timestamptz not null default now(), expires_at timestamptz not null,
 result jsonb
);
create index if not exists manager_ai_reviews_project on manager_ai_reviews(project_id,created_at desc);
`
export async function ensureAiSchema() {
  if (process.env.MANAGER_PREVIEW === '1') throw new ApiError('Preview is read-only', 503)
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("set local lock_timeout='2s'")
    await client.query("select pg_advisory_xact_lock(hashtext('manager-ai-schema'),0)")
    await client.query(AI_SCHEMA)
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
export async function aiSettings() {
  try {
    const row = (await query('select enabled,model,key_ciphertext,recovery_enabled from manager_ai_settings where id=1')).rows[0]
    return { enabled: row?.enabled === true, model: row?.model || '', configured: !!row?.key_ciphertext, recoveryEnabled: row?.recovery_enabled !== false }
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
    return { enabled: false, model: '', configured: false, recoveryEnabled: true }
  }
}
export async function saveAiSettings(body: Record<string, unknown>) {
  if (typeof body.enabled !== 'boolean' || typeof body.recoveryEnabled !== 'boolean' || typeof body.model !== 'string' || (body.model && !/^[a-zA-Z0-9._:-]{1,100}$/.test(body.model))) throw new ApiError('Invalid AI connection settings', 400)
  if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length < 20 || body.apiKey.length > 1024 || /\s/.test(body.apiKey))) throw new ApiError('Invalid API key', 400)
  await ensureAiSchema()
  const before = await aiSettings()
  if (body.enabled && (!body.model || (!before.configured && !body.apiKey) || body.removeKey)) throw new ApiError('Supply a model and API key before enabling AI diagnosis', 400)
  await query(`insert into manager_ai_settings (id,enabled,model,key_ciphertext,recovery_enabled) values(1,$1,$2,$3,$4)
    on conflict(id) do update set enabled=$1,model=$2,key_ciphertext=case when $5 then null else coalesce($3,manager_ai_settings.key_ciphertext) end,recovery_enabled=$4,updated_at=now()`,
  [body.enabled, body.model, body.apiKey ? encryptSecret(body.apiKey as string) : null, body.recoveryEnabled, body.removeKey === true])
  return aiSettings()
}
export async function aiKey() {
  const row = (await query('select key_ciphertext from manager_ai_settings where id=1 and enabled=true')).rows[0]
  if (!row?.key_ciphertext) throw new ApiError('Connect AI diagnosis in settings first', 409)
  return decryptSecret(row.key_ciphertext)
}
export async function aiHistory() {
  try { return (await query(`select id,kind,status,project_id,details,created_at from manager_ai_events order by created_at desc limit 50`)).rows }
  catch (error) { if ((error as { code?: string }).code === '42P01') return []; throw error }
}
