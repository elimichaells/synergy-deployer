import { query } from '@/lib/health-db'
import { readServerHealth } from '@/lib/server-health'
import type { ServerHealth, ServerIncident } from '@/lib/server-health-types'

const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : new Date().toISOString()
let cached: { at: number; value: Promise<ServerHealth> } | undefined
export function readUnifiedHealth() {
  if (cached && Date.now() - cached.at < 5000) return cached.value
  const value = collect()
  cached = { at: Date.now(), value }
  return value
}
async function collect(): Promise<ServerHealth> {
  const health = await readServerHealth()
  const incidents: ServerIncident[] = health.incidents.map(x => ({ ...x, source: 'Server', href: '/infrastructure/health' }))
  const sources = [
    { name: 'Memory', href: '/infrastructure/memory', sql: "select id,kind,level,message,opened_at,last_seen_at from server_alerts where resolved_at is null", map: (r: Record<string, any>): ServerIncident | null =>
      r.kind === 'low_memory' && incidents.some(i => i.key === 'memory' && !i.resolvedAt) ? null : ({ id: 'memory:' + r.id, key: 'memory:' + r.id, source: 'Memory', href: '/infrastructure/memory', severity: r.level === 'error' ? 'critical' : 'warning', message: r.message, action: 'Review application memory usage and configured limits.', openedAt: timestamp(r.opened_at), lastSeenAt: timestamp(r.last_seen_at) }) },
    { name: 'Backups', href: '/storage', sql: "select id,database_name as name,last_status,last_started_at,last_finished_at from backup_schedules where last_status in ('failed','interrupted') union all select s.id,p.name || ' / ' || s.database_name as name,b.last_status,b.last_started_at,b.last_finished_at from data_service_backup_schedules b join project_data_services s on s.id=b.service_id join projects p on p.id=s.project_id where b.last_status in ('failed','interrupted')", map: (r: Record<string, any>): ServerIncident =>
      ({ id: 'backup:' + r.id, key: 'backup:' + r.id, source: 'Backups', href: '/storage', severity: 'critical', message: 'Backup ' + r.last_status + ': ' + r.name, action: 'Inspect the backup schedule and verify a successful replacement backup.', openedAt: timestamp(r.last_started_at), lastSeenAt: timestamp(r.last_finished_at || r.last_started_at) }) },
    { name: 'Security', href: '/projects', sql: 'select id,name,security_gate_off_at,updated_at from projects where security_gate_off_until > now()', map: (r: Record<string, any>): ServerIncident =>
      ({ id: 'security:' + r.id, key: 'security:' + r.id, source: 'Security', href: '/sites/' + r.id, severity: 'warning', message: r.name + ' has an active security gate override.', action: 'Review the recorded exception and restore enforcement when the dependency issues are fixed.', openedAt: timestamp(r.security_gate_off_at || r.updated_at), lastSeenAt: new Date().toISOString() }) },
  ]
  await Promise.all(sources.map(async source => {
    try { const { rows } = await query(source.sql); for (const row of rows) { const incident = source.map(row); if (incident) incidents.push(incident) } }
    catch { incidents.push({ id: 'source:' + source.name, key: 'source:' + source.name, source: source.name, href: source.href, severity: 'warning', message: source.name + ' alerts could not be refreshed.', action: 'Check the Manager database connection and this section before assuming it is healthy.', openedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }) }
  }))
  try {
    const events = await query(`select id,status,created_at from manager_ai_events where kind='recovery'
      and (status='failed' or status='running' and created_at<now()-interval '10 minutes') order by created_at desc limit 20`)
    for (const row of events.rows) incidents.push({ id: 'operations:' + row.id, key: 'operations:' + row.id, source: 'AI Operations',
      href: '/infrastructure/operations', severity: 'warning', message: row.status === 'running' ? 'A recovery attempt has no completed verification.' : 'An application recovery attempt needs review.',
      action: 'Inspect the operation history and application readiness before allowing another attempt.',
      openedAt: timestamp(row.created_at), lastSeenAt: timestamp(row.created_at) })
  } catch (error) {
    // Older installations have no Operations schema until their first configuration.
    if ((error as { code?: string }).code !== '42P01') incidents.push({ id: 'source:Operations', key: 'source:Operations', source: 'AI Operations',
      href: '/infrastructure/operations', severity: 'warning', message: 'Recovery history could not be refreshed.',
      action: 'Check the Manager database before assuming recovery verification completed.', openedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
  }
  // Link monitor incidents to the affected app without coupling collection to PostgreSQL.
  // If this optional lookup fails, the original independent incident remains visible.
  try {
    const { rows } = await query('select id,pm2_name from projects where pm2_name is not null')
    for (const incident of incidents) {
      const name = incident.service || (/^(?:http|slow|app|restarts):/.test(incident.key) ? incident.key.slice(incident.key.indexOf(':') + 1) : undefined)
      const project = rows.find((row: Record<string, any>) => row.pm2_name === name)
      if (project) { incident.href = '/sites/' + project.id; incident.service = name }
    }
  } catch { /* Application links are optional; never suppress monitoring evidence. */ }
  incidents.sort((a, b) => Number(!!a.resolvedAt) - Number(!!b.resolvedAt) || Number(b.severity === 'critical') - Number(a.severity === 'critical') || b.openedAt.localeCompare(a.openedAt))
  return { ...health, incidents }
}
