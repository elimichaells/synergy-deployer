import assert from 'node:assert/strict'
import test from 'node:test'
import { databaseKey, hostKey, parseDatabaseEnv, uniqueDatabases } from '../lib/database-discovery-policy'

test('Prisma-style URLs are parsed with credentials, ports and TLS', () => {
  const [item] = parseDatabaseEnv('.env', { DATABASE_URL: 'postgresql://postgres:p%40ss@localhost:5432/trueid?schema=public' })
  assert.deepEqual({ ...item }, { source: '.env:DATABASE_URL', engine: 'postgresql', host: 'localhost', port: 5432, database: 'trueid', username: 'postgres', password: 'p@ss', tls: false })
  const [neon] = parseDatabaseEnv('.env', { DATABASE_URL: 'postgresql://owner:x@ep-cool.neon.tech/neondb?sslmode=require' })
  assert.equal(neon.port, 5432)
  assert.equal(neon.tls, true)
})

test('Laravel DB_* settings and Mongo URIs are recognized', () => {
  const [laravel] = parseDatabaseEnv('.env', { DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_DATABASE: 'fun4cash_db', DB_USERNAME: 'fun', DB_PASSWORD: 'secret' })
  assert.equal(laravel.engine, 'mysql')
  assert.equal(laravel.source, '.env:DB_*')
  const [mongo] = parseDatabaseEnv('.env', { MONGODB_URI: 'mongodb://app:pw@127.0.0.1/shop' })
  assert.equal(mongo.port, 27017)
  assert.equal(mongo.database, 'shop')
})

test('incomplete or unrelated settings are ignored', () => {
  assert.deepEqual(parseDatabaseEnv('.env', { DATABASE_URL: 'not a url', API_URL: 'https://example.com/v1' }), [])
  assert.deepEqual(parseDatabaseEnv('.env', { DB_DATABASE: 'only-a-name' }), [])
  assert.deepEqual(parseDatabaseEnv('.env', { DATABASE_URL: 'postgresql://localhost:5432/' }), [])
})

test('the same database seen in several env files is reported once', () => {
  const a = parseDatabaseEnv('.env', { DATABASE_URL: 'postgresql://postgres:x@localhost:5432/trueid' })
  const b = parseDatabaseEnv('.env.local', { DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:5432/trueid' })
  assert.equal(uniqueDatabases([...b, ...a]).length, 1)
  assert.equal(hostKey('LOCALHOST'), hostKey('::1'))
  assert.equal(databaseKey('postgresql', 'localhost', 5432, 'trueid'), databaseKey('postgresql', '127.0.0.1', 5432, 'trueid'))
})
