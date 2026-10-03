import assert from 'node:assert/strict'
import test from 'node:test'
import { engineFromServicePath, idleConnectionNotes, mysqlRecommendations, tuningSettings, type MysqlFacts } from '../lib/database-tuning-policy'
import { attributeMemory } from '../lib/server-memory-policy'

const facts = (overrides: Partial<MysqlFacts> = {}): MysqlFacts => ({
  engine: 'mysql', xPluginActive: true, performanceSchemaMb: 240,
  variables: { performance_schema: 'ON', innodb_log_buffer_size: String(64 * 1024 * 1024) },
  status: { mysqlx_connections_accepted: '0' }, ...overrides,
})

test('factory MySQL settings get three recommendations with what each frees', () => {
  const list = mysqlRecommendations(facts())
  assert.deepEqual(list.map(item => [item.key, item.current, item.recommended, item.savingMb, item.measured]),
    [['performance_schema', 'ON', 'OFF', 240, true], ['mysqlx', 'ON', 'OFF', 20, false], ['innodb_log_buffer_size', '64M', '16M', 48, true]])
})

test('nothing is recommended that is already done, in use, or not part of the engine', () => {
  assert.deepEqual(mysqlRecommendations(facts({ variables: { performance_schema: 'OFF', innodb_log_buffer_size: String(16 * 1024 * 1024) }, xPluginActive: false })), [])
  assert.equal(mysqlRecommendations(facts({ status: { mysqlx_connections_accepted: '4' } })).some(item => item.key === 'mysqlx'), false, 'X protocol in use')
  assert.equal(mysqlRecommendations(facts({ engine: 'mariadb' })).some(item => item.key === 'mysqlx'), false, 'MariaDB has no X protocol')
  const unmeasured = mysqlRecommendations(facts({ performanceSchemaMb: null }))[0]
  assert.deepEqual([unmeasured.savingMb, unmeasured.measured], [200, false])
})

test('only recommended changes reach the tuning script', () => {
  const list = mysqlRecommendations(facts())
  assert.equal(tuningSettings(list, ['performance_schema', 'innodb_log_buffer_size']), 'performance_schema=OFF;innodb_log_buffer_size=16M')
  assert.throws(() => tuningSettings(list, []), /at least one/)
  assert.throws(() => tuningSettings(list, ['innodb_buffer_pool_size']), /no longer recommended/)
  assert.throws(() => tuningSettings(list, 'performance_schema'), /at least one/)
})

test('logins holding many idle connections are pointed out', () => {
  const notes = idleConnectionNotes([
    { login: 'postgres', database: 'trueid', state: 'idle', count: 12 },
    { login: 'postgres', database: 'trueid', state: 'active', count: 1 },
    { login: 'app', database: 'small', state: 'idle', count: 2 },
  ])
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^postgres@trueid keeps 12 idle connections open/)
})

test('database services are recognised from their Windows service command', () => {
  assert.equal(engineFromServicePath('C:\\tools\\mysql\\current\\bin\\mysqld MySQL'), 'mysql')
  assert.equal(engineFromServicePath('"C:\\Program Files\\MariaDB 11\\bin\\mysqld.exe" MariaDB'), 'mariadb')
  assert.equal(engineFromServicePath('"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_ctl.exe" runservice -N "postgresql-x64-18"'), 'postgresql')
  assert.equal(engineFromServicePath('"C:\\Program Files\\Memurai\\memurai.exe" --service-run'), 'redis')
  assert.equal(engineFromServicePath('C:\\Windows\\system32\\svchost.exe -k netsvcs'), null)
})

test('a listening port is traced back to the service that owns its process', () => {
  const MB = 1024 * 1024
  const row = (pid: number, ppid: number, name: string, mb: number) => ({ pid, ppid, name, privateBytes: mb * MB, workingBytes: 0, started: 1 })
  const result = attributeMemory([row(1, 0, 'services.exe', 5), row(10, 1, 'mysqld.exe', 34), row(11, 10, 'mysqld.exe', 769), row(12, 10, 'conhost.exe', 1)], new Map([[10, 'service:MySQL']]))
  assert.equal(result.ownerOf(11), 'service:MySQL')
  assert.equal(result.ownerOf(1), null)
  assert.equal(result.apps[0].privateMb, 804)
})
