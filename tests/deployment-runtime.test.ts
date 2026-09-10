import assert from 'node:assert/strict'
import test from 'node:test'
import { managedStartCommand, managedRuntimeEnvironment } from '../lib/deployment-runtime'
import { captureProjectProcesses, ownedProjectProcesses, isProjectPhpServer, stopProjectProcesses, type WindowsProcess } from '../lib/deployment-processes'
import { renameReleasePath } from '../lib/deployment-filesystem'

test('managed Laravel serve has one assigned port, no reload and no fallback port', () => {
  for (const command of ['php artisan serve --host=127.0.0.1',
    'php artisan serve --host=127.0.0.1 --port 8000 --tries=10 --no-reload --port="9000"']) {
    assert.equal(managedStartCommand(command, 'laravel', 3009), 'php artisan serve --host=127.0.0.1 --port=3009 --no-reload --tries=1')
  }
  assert.equal(managedStartCommand('"C:\\Program Files\\PHP\\php.exe" artisan serve', 'laravel', 3099), '"C:\\Program Files\\PHP\\php.exe" artisan serve --port=3099 --no-reload --tries=1')
  assert.throws(() => managedStartCommand('php artisan serve --port', 'laravel', 3009), /Invalid Laravel/)
  assert.throws(() => managedStartCommand('php artisan serve && echo done', 'laravel', 3009), /single/)
  assert.throws(() => managedStartCommand('php artisan serve', 'laravel', 70000), /Invalid assigned/)
  assert.throws(() => managedStartCommand('php artisan serve --port=8000', 'laravel', null), /Invalid assigned/)
  assert.deepEqual(managedRuntimeEnvironment('laravel', 'win32'), { PHP_CLI_SERVER_WORKERS: '1' })
  assert.deepEqual(managedRuntimeEnvironment('laravel', 'linux'), {})
  assert.deepEqual(managedRuntimeEnvironment('node', 'win32'), {})
})

test('other runtime commands are not given Artisan-specific flags', () => {
  for (const [type, command] of [['laravel', 'php artisan octane:start'], ['laravel', 'custom-server.exe'], ['node', 'node index.js'], ['go', 'app.exe']]) {
    assert.equal(managedStartCommand(command, type, 3009), command)
  }
})

const proc = (pid: number, parentPid: number, overrides: Partial<WindowsProcess> = {}): WindowsProcess => ({ pid, parentPid, created: '20260831070000000', name: 'node.exe', commandLine: null, ...overrides })
const root = 'C:\\web\\production\\app'
const router = root + '\\vendor\\laravel\\framework\\src\\Illuminate\\Foundation\\Console/../resources/server.php'

test('process ownership uses ancestry plus the exact Laravel router, never only a port or root prefix', () => {
  const parent = proc(10, 1)
  const orphan = proc(20, 999, { name: 'php.exe', commandLine: `php.exe -S 127.0.0.1:3009 "${router}"` })
  const unrelated = proc(30, 999, { name: 'php.exe', commandLine: orphan.commandLine!.replace('production\\app\\', 'production\\app-copy\\') })
  const reusedChild = proc(40, 10, { created: '20260830070000000' })
  assert.equal(isProjectPhpServer(orphan, root), true)
  assert.equal(isProjectPhpServer(unrelated, root), false)
  assert.equal(isProjectPhpServer(proc(50, 1, { name: 'php.exe', commandLine: 'php.exe -S 127.0.0.1:3009 -t C:\\other' }), root), false)
  const all = [parent, proc(11, 10), proc(12, 11), orphan, unrelated, reusedChild]
  assert.deepEqual(ownedProjectProcesses(all, [parent], root).map(p => p.pid).sort(), [10, 11, 12, 20])
  assert.deepEqual(ownedProjectProcesses([proc(10, 1, { created: '20260901070000000' })], [parent]), [])
})

test('shutdown reaps verified survivors and new descendants, but preserves unrelated processes and reused PIDs', async () => {
  const parent = proc(10, 1)
  let rows = [parent, proc(11, 10), proc(99, 1)]
  const stopped: number[] = []
  const access = { list: async () => rows, stop: async (targets: WindowsProcess[]) => {
    stopped.push(...targets.map(p => p.pid))
    rows = rows.filter(p => !targets.includes(p))
  } }
  const snapshot = await captureProjectProcesses(root, [10], false, access)
  rows = [proc(10, 1, { created: '20260901070000000' }), rows[1], proc(12, 11), rows[2]]
  await stopProjectProcesses(snapshot, () => {}, access)
  assert.deepEqual(stopped.sort(), [11, 12])
  assert.deepEqual(rows.map(p => p.pid), [10, 99])
})

test('shutdown fails closed when surviving project processes cannot be stopped', async () => {
  const parent = proc(10, 1)
  await assert.rejects(stopProjectProcesses({ processes: [parent] }, () => {}, { list: async () => [parent], stop: async () => {} }), /activation blocked/)
})

test('release renames retry bounded Windows locks without deleting files or swallowing other errors', async () => {
  let attempts = 0
  const delays: number[] = []
  const locked = Object.assign(new Error('fixture lock'), { code: 'EBUSY' })
  await renameReleasePath('source', 'destination', { platform: 'win32', sleep: async delay => { delays.push(delay) }, rename: async () => { if (++attempts < 3) throw locked } })
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [200, 400])
  attempts = 0
  await assert.rejects(renameReleasePath('source', 'destination', { platform: 'win32', sleep: async () => {}, rename: async () => { attempts++; throw locked } }), /still locked/)
  assert.equal(attempts, 6)
  for (const code of ['ENOENT', 'EEXIST', 'ENOTEMPTY']) {
    await assert.rejects(renameReleasePath('source', 'destination', { platform: 'win32', rename: async () => { throw Object.assign(new Error(code), { code }) }, sleep: async () => assert.fail('must not retry') }), { message: code })
  }
})
