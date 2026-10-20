import type { ServerHealth } from './server-health-types'

export const AI_ACTIONS = ['review_database', 'review_restart', 'inspect_dependency', 'observe'] as const
export type AiAction = typeof AI_ACTIONS[number]
export interface Diagnosis {
  source: 'rules' | 'openai'; summary: string; evidence: string[]; recommendations: AiAction[]; limitations: string[]
}
export function localDiagnosis(health: ServerHealth): Diagnosis {
  const active = health.incidents.filter(i => !i.resolvedAt)
  const database = active.filter(i => i.issueCode?.startsWith('database'))
  return {
    source: 'rules',
    summary: health.stale || health.unavailable ? 'Fresh monitoring is unavailable. Recovery is blocked until checks resume.' :
      database.length ? `${database.length} application database readiness issue(s) need configuration or dependency review.` :
      active.length ? `${active.length} active alert(s) need investigation.` : 'No active alerts in the latest monitoring evidence.',
    evidence: active.slice(0, 12).map(i => `${i.service || i.source || 'Server'}: ${i.issueCode || i.key.split(':')[0]} (${i.severity})`),
    recommendations: health.stale || health.unavailable ? ['inspect_dependency'] : database.length ? ['review_database'] : active.length ? ['inspect_dependency', 'review_restart'] : ['observe'],
    limitations: ['Local rules are available without an AI connection.', 'A passing readiness sample does not prove every user workflow works.'],
  }
}
// Send only typed numbers, booleans and fixed enums. Names, paths, messages,
// source code, logs, URLs and environment values cannot enter the provider prompt.
export function providerEvidence(health: ServerHealth) {
  const codes = new Set(['database-configuration', 'database-unavailable', 'slow-response', 'http-check'])
  const services = (health.snapshot?.apps || []).slice(0, 100).map((a, index) => {
    const check = health.snapshot?.checks.find(c => c.name === a.name)
    const code = check?.diagnostics?.issueCode
    return { service: `service-${index + 1}`, status: ['online', 'errored', 'stopped', 'stopping'].includes(a.status || '') ? a.status : 'unknown',
      restarts: Math.max(0, Math.min(1e6, Number(a.restarts) || 0)), ready: check ? check.ok === true : null,
      httpStatus: Number.isInteger(check?.status) ? check!.status : null,
      responseMs: Number.isFinite(check?.ms) ? Math.min(60000, Math.max(0, check!.ms)) : null,
      issue: code && codes.has(code) ? code : check && !check.ok ? 'http-check' : null }
  })
  return { stale: !!health.stale, unavailable: !!health.unavailable, pm2Unavailable: !!health.snapshot?.pm2Error,
    collectorFailed: !!health.snapshot?.collectorError, services,
    alerts: health.incidents.filter(i => !i.resolvedAt).slice(0, 100).map(i => ({
      category: ['disk', 'disk-growth', 'memory', 'log', 'pm2-updates', 'pm2-unavailable', 'collector', 'http', 'slow', 'app', 'restarts', 'backup', 'security'].includes(i.key.split(':')[0]) ? i.key.split(':')[0] : 'other',
      severity: i.severity === 'critical' ? 'critical' : 'warning',
    })) }
}
export function validateDiagnosis(input: unknown): Diagnosis {
  const x = input as Record<string, unknown>
  if (!x || typeof x.summary !== 'string' || !x.summary.trim() || x.summary.length > 1200) throw Error('Invalid diagnosis')
  const list = (v: unknown, limit: number): string[] => {
    if (!Array.isArray(v) || v.length > limit || v.some(s => typeof s !== 'string' || s.length > 700)) throw Error('Invalid diagnosis list')
    return v
  }
  const recommendations = list(x.recommendations, 4)
  if (recommendations.some(a => !AI_ACTIONS.includes(a as AiAction))) throw Error('Unknown recommendation')
  return { source: 'openai', summary: x.summary, evidence: list(x.evidence, 12), recommendations: recommendations as AiAction[], limitations: list(x.limitations, 6) }
}
export function recoveryBlockers(health: ServerHealth, name: string, manager: boolean) {
  const blockers: string[] = []
  const app = health.snapshot?.apps.find(a => a.name === name)
  const check = health.snapshot?.checks.find(c => c.name === name)
  if (manager) blockers.push('Manager cannot recover itself through this action.')
  const checkedAt = Date.parse(health.checkedAt || '')
  if (health.stale || health.unavailable || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 5000 || Date.now() - checkedAt > 180000 || !health.snapshot || health.snapshot.pm2Error || health.snapshot.collectorError) blockers.push('Fresh, complete monitoring is required.')
  if (!app || !['online', 'errored'].includes(app.status || '')) blockers.push('Missing or intentionally stopped processes are not eligible.')
  if (check?.ok) blockers.push('The latest readiness check is healthy.')
  if (check?.diagnostics?.issueCode?.startsWith('database')) blockers.push('Review the database dependency before considering a restart.')
  if (health.incidents.some(i => !i.resolvedAt && i.severity === 'critical' && /^(disk:|memory$|pm2-|collector$)/.test(i.key))) blockers.push('A shared infrastructure incident must be resolved first.')
  if (!health.incidents.some(i => !i.resolvedAt && (i.service === name || ['http:', 'app:', 'restarts:'].some(prefix => i.key === prefix + name)))) blockers.push('A confirmed application incident is required.')
  return blockers
}
export function assertReviewTicket(ticket: { actor_id: string; status: string; expires_at: string | Date; fingerprint: string }, actor: string, fingerprint: string, now = Date.now()) {
  if (ticket.actor_id !== actor || ticket.status !== 'pending') throw Error('This review belongs to another user or has already been used.')
  if (new Date(ticket.expires_at).getTime() <= now) throw Error('This review expired. Prepare a new review.')
  if (ticket.fingerprint !== fingerprint) throw Error('Application state changed. Prepare a new review.')
}
