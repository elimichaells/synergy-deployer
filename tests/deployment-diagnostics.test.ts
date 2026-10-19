import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRuntimeDiagnostics } from '../lib/deployment-diagnostics'

test('runtime diagnostics expose the failure cause and redact credentials and control sequences', () => {
  const result = formatRuntimeDiagnostics('\x1b[31mError: Configure DATABASE_URL with the dedicated teyzar_owner database role.\x1b[0m\n' +
    'connection postgresql://user:other-password@localhost/db\npassword=raw-password\ntoken=unrecognized-token\napp secret fixture-secret',
  { OWNER_AUTH_SECRET: 'fixture-secret', DATABASE_PASSWORD: 'raw-password' })
  assert.match(result.summary!, /dedicated teyzar_owner/)
  assert.doesNotMatch(result.details, /raw-password|other-password|unrecognized-token|fixture-secret|\x1b/)
  assert.match(result.details, /\[runtime\]/)
})
