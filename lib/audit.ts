import { query } from '@/lib/db'

/** Write an entry to audit_logs. Never throws — auditing must not break the action itself. */
export async function audit(
  userId: string | null | undefined,
  action: string,
  resource: string,
  details?: Record<string, unknown>
) {
  try {
    await query(
      'insert into audit_logs (user_id, action, resource, details) values ($1, $2, $3, $4)',
      [userId || null, action, resource, details ? JSON.stringify(details) : null]
    )
  } catch (err) {
    console.error('[audit] failed to record entry:', err)
  }
}
