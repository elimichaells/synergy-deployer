import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { backupsRoot, caddyLogDir, envBackupDir, managerDataRoot, managerScript, mysqlBin, postgresBin, toolPathEntries, toolsRoot, webRoot } from '../lib/paths'

// These rules run on Windows in production; path.win32 keeps the expectations exact on any test machine.
const win = path.win32
const original = { cwd: 'C:\\web\\manager' }

test('with no settings, the original layout is unchanged', () => {
  if (process.platform !== 'win32') return
  assert.equal(webRoot({}, original.cwd), 'C:\\web')
  assert.equal(toolsRoot({}, original.cwd), 'C:\\web\\tools')
  assert.equal(backupsRoot({}, original.cwd), 'C:\\web\\backups')
  assert.equal(envBackupDir({}, original.cwd), 'C:\\web\\backups\\manager-env')
  assert.equal(managerScript('install-sling.ps1', {}, original.cwd), 'C:\\web\\manager\\scripts\\install-sling.ps1')
  assert.equal(caddyLogDir({}, original.cwd, file => file === 'C:\\Caddy\\logs'), 'C:\\Caddy\\logs', 'an existing legacy log folder keeps being used')
  assert.equal(caddyLogDir({}, original.cwd, () => false), 'C:\\web\\logs\\caddy')
  assert.equal(managerDataRoot({ PROGRAMDATA: 'C:\\ProgramData' }), 'C:\\ProgramData\\Manager')
})

test('a manager installed in another folder finds everything beside it', () => {
  if (process.platform !== 'win32') return
  const cwd = 'D:\\Hosting\\synergy\\manager'
  assert.equal(webRoot({}, cwd), 'D:\\Hosting\\synergy')
  assert.equal(toolsRoot({}, cwd), 'D:\\Hosting\\synergy\\tools')
  assert.equal(caddyLogDir({}, cwd, () => false), 'D:\\Hosting\\synergy\\logs\\caddy')
  assert.equal(webRoot({ MANAGER_WEB_ROOT: 'E:\\sites' }, cwd), 'E:\\sites', 'the installer setting wins')
  assert.equal(webRoot({ CADDY_PATH: 'F:\\web' }, cwd), 'F:\\web', 'older installs set CADDY_PATH')
  assert.equal(toolsRoot({ MANAGER_TOOLS_ROOT: 'G:\\tools' }, cwd), 'G:\\tools')
  assert.equal(caddyLogDir({ CADDY_LOG_DIR: 'H:\\logs' }, cwd, () => true), 'H:\\logs')
  assert.equal(webRoot({ MANAGER_WEB_ROOT: '  ' }, cwd), 'D:\\Hosting\\synergy', 'blank settings are ignored')
})

test('PostgreSQL and MySQL are found wherever they are installed, newest PostgreSQL first', () => {
  if (process.platform !== 'win32') return
  const files = new Set([
    win.join('C:\\Program Files\\PostgreSQL', '16', 'bin', 'psql.exe'), win.join('C:\\Program Files\\PostgreSQL', '18', 'bin', 'psql.exe'),
    win.join('C:\\Program Files\\MySQL', 'MySQL Server 8.4', 'bin', 'mysql.exe'),
  ])
  const probe = { exists: (file: string) => files.has(file) || [...files].some(item => item.startsWith(file + '\\')), list: (dir: string) => dir.endsWith('PostgreSQL') ? ['16', '18', 'pgAdmin 4'] : dir.endsWith('MySQL') ? ['MySQL Server 8.4'] : [] }
  const env = { ProgramFiles: 'C:\\Program Files' }
  assert.equal(postgresBin(env, probe), 'C:\\Program Files\\PostgreSQL\\18\\bin')
  assert.equal(postgresBin({ ...env, PG_BIN_PATH: 'X:\\pg\\bin' }, probe), 'X:\\pg\\bin')
  assert.equal(mysqlBin(env, probe), 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin')
  assert.equal(postgresBin(env, { exists: () => false, list: () => [] }), null)
  const entries = toolPathEntries(env, probe)
  assert.deepEqual(entries, ['C:\\Program Files\\PostgreSQL\\18\\bin', 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin'], 'only folders that exist are added to PATH')
})
