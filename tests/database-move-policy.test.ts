import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCopies, estimateMoveMinutes, filterRestoreList, moveTargetName, rewriteEnvLocation } from '../lib/database-move-policy'

const from = { host: 'localhost', port: 5432, database: 'trueid', username: 'postgres' }
const to = { host: '127.0.0.1', port: 5433, database: 'trueid', username: 'trueid_app', password: 'n3w&secret' }

test('a connection URL moves to the new server and login, keeping its options', () => {
  const env = ['# app settings', 'DATABASE_URL="postgresql://postgres:old@localhost:5432/trueid?schema=public&connection_limit=5"', 'OTHER_URL=postgresql://postgres:old@localhost:5432/other', 'JWT_SECRET=x'].join('\r\n')
  const result = rewriteEnvLocation(env, from, to)
  assert.equal(result.changed, 1)
  const lines = result.content.split('\r\n')
  assert.equal(lines[1], 'DATABASE_URL="postgresql://trueid_app:n3w%26secret@127.0.0.1:5433/trueid?schema=public&connection_limit=5"')
  assert.equal(lines[2], 'OTHER_URL=postgresql://postgres:old@localhost:5432/other', 'other databases are left alone')
  assert.equal(lines[0], '# app settings')
  assert.ok(result.content.includes('\r\n'), 'Windows line endings are kept')
})

test('separate-key settings (Laravel and plain) move together, and a missing password line is added', () => {
  const laravel = rewriteEnvLocation('DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_DATABASE=trueid\nDB_USERNAME=postgres\n', { ...from, host: '127.0.0.1' }, to)
  assert.match(laravel.content, /DB_PORT=5433/)
  assert.match(laravel.content, /DB_USERNAME=trueid_app/)
  assert.match(laravel.content, /DB_PASSWORD=n3w&secret$/)
  const plain = rewriteEnvLocation('DATABASE_HOST=localhost\nDATABASE_PORT=5432\nDATABASE_NAME=trueid\nDATABASE_USER=postgres\nDATABASE_PASSWORD=old', from, { ...to, database: 'trueid_2' })
  assert.match(plain.content, /DATABASE_NAME=trueid_2/)
  assert.match(plain.content, /DATABASE_PASSWORD=n3w&secret/)
  const elsewhere = rewriteEnvLocation('DB_HOST=127.0.0.1\nDB_PORT=5432\nDB_DATABASE=billing\nDB_USERNAME=postgres', from, to)
  assert.equal(elsewhere.changed, 0, 'a different database is not touched')
})

test('extensions and their comments are left out of the restore list', () => {
  const list = [';', '; Archive created at 2026-10-03', '3; 3079 16385 EXTENSION - pg_trgm', '4234; 0 0 COMMENT - EXTENSION pg_trgm', '219; 1259 16400 TABLE public users postgres', '4100; 0 16400 TABLE DATA public users postgres'].join('\n')
  const filtered = filterRestoreList(list)
  assert.ok(!filtered.includes('EXTENSION'))
  assert.ok(filtered.includes('TABLE public users') && filtered.includes('TABLE DATA public users'))
})

test('the copy is only accepted when rows, sequences and objects all match', () => {
  const source = { rows: { 'public.users': 10, 'public.orders': 4 }, sequences: { 'public.orders_id_seq': 4, 'public.unused_seq': null }, objects: { views: 2, functions: 3 } }
  assert.deepEqual(compareCopies(source, structuredClone(source)), [])
  const target = { rows: { 'public.users': 9, 'public.extra': 0 }, sequences: { 'public.orders_id_seq': 1, 'public.unused_seq': null }, objects: { views: 2 } }
  const differences = compareCopies(source, target)
  assert.deepEqual(differences, [
    'Table public.users has 9 rows in the copy and 10 in the original',
    'Table public.orders is missing from the copy',
    'Table public.extra exists only in the copy',
    'Sequence public.orders_id_seq is at 1 in the copy and 4 in the original',
    '3 functions in the original, 0 in the copy',
  ])
})

test('downtime estimates and target names', () => {
  assert.deepEqual(estimateMoveMinutes(12 * 1024 ** 2), { low: 1, high: 2 })
  assert.deepEqual(estimateMoveMinutes(4.4 * 1024 ** 3), { low: 6, high: 14 })
  assert.equal(moveTargetName('trueid', new Set(['postgres'])), 'trueid')
  assert.equal(moveTargetName('trueid', new Set(['trueid', 'trueid_2'])), 'trueid_3')
})
