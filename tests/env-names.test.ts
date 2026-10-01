import assert from 'node:assert/strict'
import test from 'node:test'
import { envNames } from '../lib/env-names'
import { describeEnvName } from '../lib/env-describe'

test('only variable names come out of an env file, never values', () => {
  const names = envNames('# comment\nDATABASE_URL="postgres://u:p@h/db"\nJWT_SECRET=abc\nEMPTY=\nexport PORT=3000\nbad line\n')
  assert.deepEqual(names, ['DATABASE_URL', 'JWT_SECRET', 'EMPTY', 'PORT'])
  assert.ok(!names.join(' ').includes('postgres://'))
  assert.deepEqual(envNames(''), [])
})

test('variables get a plain-language description when the name makes the purpose clear', () => {
  assert.equal(describeEnvName('DATABASE_URL'), 'Database connection')
  assert.equal(describeEnvName('POSTGRES_PRISMA_URL'), 'Database connection')
  assert.equal(describeEnvName('JWT_SECRET'), 'Secret')
  assert.equal(describeEnvName('STRIPE_API_KEY'), 'Secret')
  assert.equal(describeEnvName('SMTP_HOST'), 'Email')
  assert.equal(describeEnvName('PUBLIC_APP_URL'), 'Address')
  assert.equal(describeEnvName('NODE_ENV'), 'App setting')
  assert.equal(describeEnvName('SOMETHING_ELSE'), null)
})
