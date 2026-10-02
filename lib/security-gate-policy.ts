/** Rules for deliberately deploying past the dependency security gate. Pure and testable. */

export const GATE_SCOPES = ['once', '7d', '30d', 'always'] as const
export type GateScope = typeof GATE_SCOPES[number]
export const MIN_REASON_LENGTH = 15
export const MAX_REASON_LENGTH = 300

export const scopeLabels: Record<GateScope, string> = {
  once: 'This deployment only',
  '7d': 'This app, for 7 days',
  '30d': 'This app, for 30 days',
  always: 'This app, until someone turns the gate back on',
}

/** When a longer-lived override ends. `null` means it does not outlive the one deployment. */
export function gateOffUntil(scope: GateScope, now = Date.now()): string | null {
  if (scope === 'once') return null
  if (scope === 'always') return 'infinity'
  return new Date(now + (scope === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000).toISOString()
}

/** A reason is stored and shown in logs, so it is kept on one line and bounded. */
export function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH) : ''
}

/** Validates a request to deploy past the gate. Throws a message the person can act on. */
export function validateGateOverride(body: { scope?: unknown; reason?: unknown; understood?: unknown } | null) {
  const scope = (GATE_SCOPES as readonly unknown[]).includes(body?.scope) ? body!.scope as GateScope : null
  if (!scope) throw new Error('Choose how long the security gate stays off')
  const reason = cleanReason(body?.reason)
  if (reason.length < MIN_REASON_LENGTH) throw new Error(`Say why this is acceptable, in at least ${MIN_REASON_LENGTH} characters. It is recorded with the deployment.`)
  if (body?.understood !== true) throw new Error('Confirm that you understand the risk')
  return { scope, reason }
}

export interface SecurityFinding {
  severity: 'critical' | 'high'
  package: string
  affected: string
  advisories: { title: string; url: string | null }[]
  fix: string | null
}

/** Reads the findings the gate wrote to a deployment log. */
export function parseSecurityFindings(log: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  let current: SecurityFinding | null = null
  for (const raw of log.split(/\r?\n/)) {
    const head = /^\[security\] (critical|high): (.+?) \(affected: (.*)\)$/.exec(raw)
    if (head) {
      current = { severity: head[1] as SecurityFinding['severity'], package: head[2], affected: head[3], advisories: [], fix: null }
      // The gate reports before installing and again after building; keep one entry per package.
      if (!findings.some(item => item.package === current!.package && item.severity === current!.severity)) findings.push(current)
      else current = null
      continue
    }
    if (!current || !raw.startsWith('[security]   ')) { if (!raw.startsWith('[security]')) current = null; continue }
    const detail = raw.slice('[security]   '.length)
    if (/^npm suggests |^Compatible update available|^No automatic fix/.test(detail)) { current.fix = detail.replace(/\.$/, ''); continue }
    if (/^Via dependency: /.test(detail)) continue
    const [title, url] = detail.split(' — ')
    current.advisories.push({ title: title.trim(), url: url && /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(url.trim()) ? url.trim() : null })
  }
  return findings.sort((a, b) => (a.severity === b.severity ? a.package.localeCompare(b.package) : a.severity === 'critical' ? -1 : 1))
}

/** Plain-language summary of what is being accepted. */
export function findingsSummary(findings: SecurityFinding[]) {
  const critical = findings.filter(item => item.severity === 'critical').length
  const high = findings.length - critical
  const parts = [critical ? `${critical} critical` : '', high ? `${high} high` : ''].filter(Boolean)
  return parts.length ? `${parts.join(' and ')} severity ${findings.length === 1 ? 'vulnerability' : 'vulnerabilities'}` : 'known vulnerabilities'
}

export interface FixCommand { command: string; note: string }

/** The commands a developer runs in the app's own code to clear the findings. */
export function fixCommands(findings: SecurityFinding[]): FixCommand[] {
  const commands: FixCommand[] = []
  const add = (command: string, note: string) => { if (!commands.some(item => item.command === command)) commands.push({ command, note }) }
  if (findings.some(item => item.fix?.startsWith('Compatible update available'))) add('npm audit fix', 'Applies the updates that stay within the versions your app already allows.')
  for (const finding of findings) {
    const suggested = /^npm suggests ((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)@(\d[0-9A-Za-z.+-]*)( \(major upgrade)?/.exec(finding.fix || '')
    if (suggested) add(`npm install ${suggested[1]}@${suggested[2]}`, suggested[3] ? 'A major upgrade: read its upgrade notes and test the app before pushing.' : `Updates ${suggested[1]} to a fixed version.`)
  }
  return commands
}

/** Why a release went out past the gate, as recorded in its own log. */
export function overrideReason(log: string): { scope: 'deployment' | 'app'; reason: string } | null {
  const match = /^\[security\] OVERRIDE: continuing because an administrator turned the security gate off for this (deployment|app)\. Reason given: (.*)$/m.exec(log)
  return match ? { scope: match[1] as 'deployment' | 'app', reason: match[2].trim() } : null
}
