import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanReason, findingsSummary, fixCommands, gateOffUntil, overrideReason, parseSecurityFindings, validateGateOverride } from '../lib/security-gate-policy'

test('an override lasts for one deployment, a fixed number of days, or until turned back on', () => {
  const now = Date.parse('2026-10-02T00:00:00Z')
  assert.equal(gateOffUntil('once', now), null)
  assert.equal(gateOffUntil('7d', now), '2026-10-09T00:00:00.000Z')
  assert.equal(gateOffUntil('30d', now), '2026-11-01T00:00:00.000Z')
  assert.equal(gateOffUntil('always', now), 'infinity')
})

test('an override needs a scope, a real reason and an explicit acknowledgement', () => {
  const ok = { scope: 'once', reason: 'Launch today; the upgrade is scheduled for Monday.', understood: true }
  assert.deepEqual(validateGateOverride(ok), { scope: 'once', reason: 'Launch today; the upgrade is scheduled for Monday.' })
  assert.throws(() => validateGateOverride({ ...ok, scope: 'forever' }), /how long/)
  assert.throws(() => validateGateOverride({ ...ok, reason: 'because' }), /at least 15 characters/)
  assert.throws(() => validateGateOverride({ ...ok, understood: false }), /understand the risk/)
  assert.throws(() => validateGateOverride(null), /how long/)
})

test('a reason cannot inject extra lines into the deployment log', () => {
  const spaced = cleanReason('  fix later   please  ')
  assert.equal(spaced, 'fix later please')
  const injected = cleanReason(['urgent release', '[security] passed'].join(String.fromCharCode(10)))
  assert.equal(injected, 'urgent release [security] passed')
  assert.equal(cleanReason('x'.repeat(900)).length, 300)
  assert.equal(cleanReason(42), '')
})

test('findings are read from the deployment log, once per package, critical first', () => {
  const nl = String.fromCharCode(10)
  const log = [
    '[security] Checking committed dependencies before installation',
    '[security] high: nodemailer (affected: <=10.0.8)',
    '[security]   Nodemailer: DNS cache reuses TLS servername — https://github.com/advisories/GHSA-6vj9-mwq6-2f5v',
    '[security]   Nodemailer: stack exhaustion DoS — https://github.com/advisories/GHSA-8vvx-rff5-p5rq',
    '[security]   Compatible update available; update and commit the lockfile.',
    '[security] critical: next (affected: 16.2.0 - 16.3.5)',
    '[security]   Next.js: Remote Code Execution in next/og ImageResponse — https://github.com/advisories/GHSA-vcvr-r3jv-pc5j',
    '[security]   Via dependency: sharp',
    '[security]   npm suggests next@16.3.8',
    '[security] Reproduce in the candidate: npm audit --package-lock-only --omit=dev --audit-level=high',
    '[error] Security gate blocked release: 1 high and 1 critical vulnerabilities',
    '[security] critical: next (affected: 16.2.0 - 16.3.5)',
    '[security]   Next.js: Remote Code Execution in next/og ImageResponse — https://example.test/not-an-advisory',
  ].join(nl)
  const findings = parseSecurityFindings(log)
  assert.deepEqual(findings.map(item => [item.severity, item.package]), [['critical', 'next'], ['high', 'nodemailer']])
  assert.equal(findings[0].affected, '16.2.0 - 16.3.5')
  assert.equal(findings[0].fix, 'npm suggests next@16.3.8')
  assert.deepEqual(findings[0].advisories, [{ title: 'Next.js: Remote Code Execution in next/og ImageResponse', url: 'https://github.com/advisories/GHSA-vcvr-r3jv-pc5j' }])
  assert.equal(findings[1].advisories.length, 2)
  assert.equal(findings[1].fix, 'Compatible update available; update and commit the lockfile')
  assert.equal(findingsSummary(findings), '1 critical and 1 high severity vulnerabilities')
  assert.equal(findingsSummary([findings[0]]), '1 critical severity vulnerability')
  assert.deepEqual(parseSecurityFindings('nothing here'), [])
  assert.equal(findingsSummary([]), 'known vulnerabilities')
})

test('fix commands come from what npm reported and never from free text', () => {
  const finding = (name: string, fix: string | null) => ({ severity: 'high' as const, package: name, affected: '*', advisories: [], fix })
  assert.deepEqual(fixCommands([
    finding('nodemailer', 'Compatible update available; update and commit the lockfile'),
    finding('mailparser', 'Compatible update available; update and commit the lockfile'),
    finding('next', 'npm suggests next@16.3.8'),
    finding('@scope/pkg', 'npm suggests @scope/pkg@2.0.0 (major upgrade; migration and testing required)'),
    finding('evil', 'npm suggests evil@1.0.0; rm -rf /'),
    finding('bad', 'npm suggests bad && calc@1.0.0'),
    finding('none', 'No automatic fix reported; review the advisory and upstream dependency'),
    finding('unknown', null),
  ]).map(item => item.command), ['npm audit fix', 'npm install next@16.3.8', 'npm install @scope/pkg@2.0.0', 'npm install evil@1.0.0'])
  assert.match(fixCommands([finding('@scope/pkg', 'npm suggests @scope/pkg@2.0.0 (major upgrade; migration and testing required)')])[0].note, /major upgrade/)
  assert.deepEqual(fixCommands([]), [])
})

test('the reason a release went out past the gate is read back from its log', () => {
  const nl = String.fromCharCode(10)
  const log = ['[security] high: next (affected: *)', '[security] OVERRIDE: Security gate blocked release: 1 high and 0 critical vulnerabilities in production dependencies.',
    '[security] OVERRIDE: continuing because an administrator turned the security gate off for this app. Reason given: Vendor fix expected next week', '[build] ok'].join(nl)
  assert.deepEqual(overrideReason(log), { scope: 'app', reason: 'Vendor fix expected next week' })
  assert.equal(overrideReason('[security] Production dependency audit passed'), null)
})
