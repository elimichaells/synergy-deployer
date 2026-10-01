import assert from 'node:assert/strict'
import test from 'node:test'
import { dropBlocker, isProtectedDatabase, parseServerDatabaseId, serverDatabaseId } from '../lib/server-database-policy'

test('server database ids round-trip, including awkward names', () => {
  const id = serverDatabaseId('0b1c2d3e', 'my db/with~odd name')
  assert.deepEqual(parseServerDatabaseId(id), { connectionId: '0b1c2d3e', database: 'my db/with~odd name' })
  assert.equal(parseServerDatabaseId('0b1c2d3e'), null)
  assert.equal(parseServerDatabaseId('server~only-connection'), null)
  assert.equal(parseServerDatabaseId('server~a~b~c'), null)
  assert.equal(parseServerDatabaseId('server~a~%E0%A4%A'), null)
})

test('system databases and the control database are protected', () => {
  for (const name of ['postgres', 'template0', 'template1']) assert.equal(isProtectedDatabase(name, 'server_manager', false), true)
  assert.equal(isProtectedDatabase('server_manager', 'server_manager', true), true)
  assert.equal(isProtectedDatabase('server_manager', 'server_manager', false), false)
  assert.equal(isProtectedDatabase('fun4cash', 'server_manager', true), false)
})

test('a database that any app tracks or is configured to use cannot be dropped', () => {
  const base = { name: 'fun4cash', controlDatabase: 'server_manager', isSystemServer: true, trackedBy: [] as string[], usedBy: [] as string[] }
  assert.equal(dropBlocker(base), null)
  assert.match(dropBlocker({ ...base, trackedBy: ['Billing'] })!, /Billing uses this database/)
  assert.match(dropBlocker({ ...base, trackedBy: ['A', 'B'] })!, /A, B use this database/)
  assert.match(dropBlocker({ ...base, usedBy: ['Staging'] })!, /Staging is configured/)
  assert.match(dropBlocker({ ...base, name: 'postgres' })!, /protected/)
})
