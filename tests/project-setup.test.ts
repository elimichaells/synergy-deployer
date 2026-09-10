import assert from 'node:assert/strict'
import test from 'node:test'
import { SETUP_STEPS, setupReady, validateSetupProgress, validateSetupRepository } from '../lib/project-setup-policy'
import { validateConsoleCommand, projectQuickCommands, readProjectEnvironment, resolveConsoleWorkingDirectory, prepareConsoleCommand } from '../lib/project-console'
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

test('setup progress persists only allowed decisions, never arbitrary credentials', () => {
  assert.deepEqual(validateSetupProgress({ step: 'environment', decisions: { environment: 'file', password: 'do-not-store', content: 'SECRET=x' }, password: 'not-stored' }), { step: 'environment', decisions: { environment: 'file' } })
  for (const step of SETUP_STEPS) assert.equal(validateSetupProgress({ step }).step, step)
  for (const input of [null, {}, { step: 'not-real' }, { step: 'runtime', decisions: [] }, { step: 'domain', decisions: { domain: 'yes' } }]) assert.throws(() => validateSetupProgress(input))
})

test('review requires checks and rejects blockers but permits explicit warnings', () => {
  assert.equal(setupReady([]), false)
  assert.equal(setupReady([{ id: 'dns', step: 'domain', label: 'Domain', status: 'warning', detail: 'Deferred' }]), true)
  assert.equal(setupReady([{ id: 'runtime', step: 'runtime', label: 'Runtime', status: 'fail', detail: 'Missing' }]), false)
})

test('repository preparation accepts GitHub branches without credential-bearing URLs or shell syntax', () => {
  validateSetupRepository('https://github.com/team/application.git', 'release/staging')
  for (const repo of ['https://token@github.com/team/app', 'http://github.com/team/app', 'https://github.com.evil.test/team/app', 'https://github.com/team/app?token=abc', 'file:///C:/source']) assert.throws(() => validateSetupRepository(repo, 'main'))
  for (const branch of ['--help', 'main & whoami', 'feature/../main', 'release.lock', 'main\n']) assert.throws(() => validateSetupRepository('https://github.com/team/app', branch))
})

test('console supports any single-line project command and bounds requests', () => {
  for (const command of ['php artisan migrate:status', 'composer install --no-interaction', 'go test ./...', 'git status --short', 'npm run build', 'node --version', 'powershell Get-Process', 'cmd /c dir', 'npm ci && npm test', 'php --version | more', 'where.exe php']) assert.equal(validateConsoleCommand(command), null, command)
  for (const command of ['', null, {}, 'npm run\nbuild', 'cmd /c echo one\r\necho two', `echo ${String.fromCharCode(0)} unsafe`]) assert.ok(validateConsoleCommand(command), String(command))
  assert.ok(validateConsoleCommand('echo ' + 'a'.repeat(8000)))
})

test('console suggestions follow the selected project framework', () => {
  assert.ok(projectQuickCommands('go').every(command => command.startsWith('go ')))
  assert.ok(projectQuickCommands('laravel').includes('php artisan migrate:status'))
  assert.ok(projectQuickCommands('angular').includes('npm run build'))
})

test('console invokes PowerShell syntax without changing ordinary project commands', () => {
  assert.equal(prepareConsoleCommand('npm run build && npm test'), 'npm run build && npm test')
  assert.equal(prepareConsoleCommand('composer install --no-interaction'), 'composer install --no-interaction')
  for (const command of ['Get-ChildItem -Force', '$env:Path', 'ls | Select-Object Name']) {
    const prepared = prepareConsoleCommand(command)
    assert.match(prepared, /^powershell\.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand /)
    const script = Buffer.from(prepared.split(' ').at(-1)!, 'base64').toString('utf16le')
    assert.match(script, /^\$ProgressPreference='SilentlyContinue'/)
    assert.ok(script.endsWith(command))
  }
})

test('project environment parsing preserves framework precedence without inheriting Manager secrets', async t => {
  const temp = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(temp, 'manager-console-test-'))
  t.after(async () => { assert.equal(path.dirname(root), temp); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: true }) })
  await writeFile(path.join(root, '.env'), 'VALUE=base\nDATABASE_NAME=project_db\n')
  await writeFile(path.join(root, '.env.local'), 'VALUE=local\n')
  assert.deepEqual(await readProjectEnvironment(root, 'node'), { VALUE: 'local', DATABASE_NAME: 'project_db' })
  assert.deepEqual(await readProjectEnvironment(root, 'laravel'), { VALUE: 'base', DATABASE_NAME: 'project_db' })
})

test('console working directory persists inside the application boundary', async t => {
  const temp = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(temp, 'manager-cwd-test-'))
  const child = path.join(root, 'storage', 'logs')
  await mkdir(child, { recursive: true })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  assert.equal(await resolveConsoleWorkingDirectory(root), await realpath(root))
  assert.equal(await resolveConsoleWorkingDirectory(root, 'storage\\logs'), await realpath(child))
  await assert.rejects(() => resolveConsoleWorkingDirectory(root, '..'), /inside the application root/)
})
