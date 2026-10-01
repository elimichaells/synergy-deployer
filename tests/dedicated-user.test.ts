import assert from 'node:assert/strict'
import test from 'node:test'
import { ownershipStatement, quoteIdent, roleNameFor, rewriteEnvCredentials } from '../lib/dedicated-user-policy'

const target = { host: '127.0.0.1', port: 5432, database: 'trueid', username: 'postgres' }

test('role names are safe, readable and unique', () => {
  assert.equal(roleNameFor('trueid', new Set()), 'trueid_app')
  assert.equal(roleNameFor('trueid', new Set(['trueid_app'])), 'trueid_app2')
  assert.equal(roleNameFor('flowBase', new Set()), 'flowbase_app')
  assert.equal(roleNameFor('9lives-db', new Set()), 'db_9lives_db_app')
})

test('only the matching URL credentials change; comments, other keys and quoting are kept', () => {
  const content = [
    '# Database',
    'DATABASE_URL="postgresql://postgres:old@localhost:5432/trueid?schema=public"',
    'SHADOW_URL=postgresql://postgres:old@localhost:5432/trueid_shadow',
    'OTHER_DATABASE_URL=postgresql://postgres:old@localhost:5432/trueid',
    'NEXTAUTH_SECRET=keep-me',
  ].join('\r\n')
  const result = rewriteEnvCredentials(content, target, 'trueid_app', 'n3w/pass')
  assert.equal(result.changed, 1)
  const lines = result.content.split('\r\n')
  assert.equal(lines[1], 'DATABASE_URL="postgresql://trueid_app:n3w%2Fpass@localhost:5432/trueid?schema=public"')
  assert.equal(lines[2], 'SHADOW_URL=postgresql://postgres:old@localhost:5432/trueid_shadow', 'other databases are untouched')
  assert.equal(lines[3], 'OTHER_DATABASE_URL=postgresql://postgres:old@localhost:5432/trueid', 'unknown keys are untouched')
  assert.equal(lines[4], 'NEXTAUTH_SECRET=keep-me')
})

test('a URL for another user or server is left alone', () => {
  for (const url of ['postgresql://someone:x@localhost:5432/trueid', 'postgresql://postgres:x@localhost:5433/trueid', 'postgresql://postgres:x@db.example.com:5432/trueid']) {
    assert.equal(rewriteEnvCredentials(`DATABASE_URL=${url}`, target, 'trueid_app', 'pw').changed, 0, url)
  }
})

test('Laravel-style settings get the new user and password, adding a password line if missing', () => {
  const laravel = rewriteEnvCredentials('DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_DATABASE=trueid\nDB_USERNAME=postgres\nDB_PASSWORD=old', target, 'trueid_app', 'pw')
  assert.equal(laravel.changed, 2)
  assert.match(laravel.content, /^DB_USERNAME=trueid_app$/m)
  assert.match(laravel.content, /^DB_PASSWORD=pw$/m)
  const missing = rewriteEnvCredentials('DB_HOST=127.0.0.1\nDB_DATABASE=trueid\nDB_USERNAME=postgres', target, 'trueid_app', 'pw')
  assert.match(missing.content, /DB_PASSWORD=pw$/)
  const otherDb = rewriteEnvCredentials('DB_HOST=127.0.0.1\nDB_DATABASE=other\nDB_USERNAME=postgres\nDB_PASSWORD=old', target, 'trueid_app', 'pw')
  assert.equal(otherDb.changed, 0)
})

test('ownership statements quote identifiers and include routine signatures', () => {
  assert.equal(ownershipStatement({ kind: 'r', schema: 'public', name: 'User' }, 'trueid_app'), 'ALTER TABLE "public"."User" OWNER TO "trueid_app"')
  assert.equal(ownershipStatement({ kind: 'm', schema: 'public', name: 'stats' }, 'a'), 'ALTER MATERIALIZED VIEW "public"."stats" OWNER TO "a"')
  assert.equal(ownershipStatement({ kind: 'function', schema: 'public', name: 'touch', args: 'integer, text' }, 'a'), 'ALTER FUNCTION "public"."touch"(integer, text) OWNER TO "a"')
  assert.equal(ownershipStatement({ kind: 'schema', schema: 'app', name: 'app' }, 'a'), 'ALTER SCHEMA "app" OWNER TO "a"')
  assert.equal(quoteIdent('we"ird'), '"we""ird"')
  assert.throws(() => ownershipStatement({ kind: 'x', schema: 's', name: 'n' }, 'a'))
})
