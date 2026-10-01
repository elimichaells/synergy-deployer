import assert from 'node:assert/strict'
import test from 'node:test'
import { checkMemberChange, validateNewUser, validatePassword } from '../lib/user-admin-policy'

const admin = { id: 'a', role: 'admin', status: 'active' }

test('new members need a valid email, name, role and a long password', () => {
  assert.deepEqual(validateNewUser({ email: ' Dev@Example.com ', name: ' Dev ', role: 'operator', password: 'long-enough-password' }),
    { email: 'dev@example.com', name: 'Dev', role: 'operator', password: 'long-enough-password' })
  for (const bad of [{ email: 'nope' }, { name: '' }, { role: 'owner' }, { password: 'short' }]) {
    assert.throws(() => validateNewUser({ email: 'dev@example.com', name: 'Dev', role: 'viewer', password: 'long-enough-password', ...bad }))
  }
  assert.throws(() => validatePassword(undefined))
})

test('administrators cannot demote or disable themselves', () => {
  assert.throws(() => checkMemberChange({ actorId: 'a', target: admin, role: 'viewer', activeAdmins: 3 }), /own role/)
  assert.throws(() => checkMemberChange({ actorId: 'a', target: admin, status: 'disabled', activeAdmins: 3 }), /own account/)
  assert.deepEqual(checkMemberChange({ actorId: 'a', target: admin, role: 'admin', activeAdmins: 1 }), { role: 'admin' })
})

test('the last active administrator cannot be removed', () => {
  assert.throws(() => checkMemberChange({ actorId: 'b', target: admin, role: 'viewer', activeAdmins: 1 }), /at least one/)
  assert.throws(() => checkMemberChange({ actorId: 'b', target: admin, status: 'disabled', activeAdmins: 1 }), /at least one/)
  assert.deepEqual(checkMemberChange({ actorId: 'b', target: admin, role: 'viewer', activeAdmins: 2 }), { role: 'viewer' })
})

test('other changes are validated and non-empty', () => {
  const viewer = { id: 'v', role: 'viewer', status: 'active' }
  assert.deepEqual(checkMemberChange({ actorId: 'a', target: viewer, status: 'disabled', activeAdmins: 1 }), { status: 'disabled' })
  assert.throws(() => checkMemberChange({ actorId: 'a', target: viewer, role: 'owner', activeAdmins: 1 }), /Unknown role/)
  assert.throws(() => checkMemberChange({ actorId: 'a', target: viewer, activeAdmins: 1 }), /Nothing/)
})
