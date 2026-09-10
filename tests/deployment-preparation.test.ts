import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultInstallCommand, detectCheckoutProjectType, isDependencyCleanupFailure, localNpmInstall, prepareProjectCheckout, prepareProjectParent, resolveCheckoutCommands, runPreparedDeploymentCommand } from '../lib/deployment-preparation'
import { getProjectCommandOverrides, getProjectTypeDefaults } from '../lib/project-types'

async function fixture(t: TestContext, files: Record<string, string> = {}) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'manager-prepare-test-'))
  t.after(async () => {
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith('manager-prepare-test-'))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), content)
  }
  return root
}

const npmFiles = { 'package.json': '{}', 'package-lock.json': '{"lockfileVersion":3}', '.env': 'EXAMPLE=preserved', 'node_modules/old.txt': 'old dependencies' }
const nextDefaults = { project_type: 'next' as const, install_cmd: 'npm install', build_cmd: 'npm run build', start_cmd: 'npm start' }
const ok = { code: 0, output: 'installed' }
const cleanupError = (root: string) => ({ code: 1, output: `npm error code ENOTEMPTY\nnpm error syscall rmdir\nnpm error path ${path.join(root, 'node_modules', '@angular', 'cdk', 'text-field')}` })

test('creates parent directories without populating or replacing the checkout', async t => {
  const root = await fixture(t, { 'occupied.txt': 'preserved' })
  const checkout = path.join(root, 'production', 'project')
  await prepareProjectParent(checkout)
  assert.deepEqual(await readdir(path.dirname(checkout)), [])
  await assert.rejects(prepareProjectParent('relative'), /absolute/)
  await assert.rejects(prepareProjectParent(path.parse(root).root), /root cannot/)
  await assert.rejects(prepareProjectParent(path.join(root, 'occupied.txt')), /not a directory/)
})

test('detects frameworks from checked-out manifests, with ambiguity left unresolved', async t => {
  const cases: Array<[Record<string, string>, string | undefined]> = [
    [{ 'package.json': '{"dependencies":{"@angular/core":"17"}}', 'angular.json': '{}' }, 'angular'],
    [{ 'package.json': '{"dependencies":{"next":"15"}}' }, 'next'],
    [{ 'go.mod': 'module example' }, 'go'],
    [{ 'composer.json': '{}', artisan: '', 'package.json': '{}' }, 'laravel'],
    [{ 'package.json': '{}' }, 'node'],
    [{ 'go.mod': 'module example', 'package.json': '{"dependencies":{"next":"15"}}' }, undefined],
  ]
  for (const [files, expected] of cases) assert.equal(await detectCheckoutProjectType(await fixture(t, files)), expected)
})

test('corrects only legacy Next defaults, preserving custom configuration', () => {
  const project = { ...nextDefaults, port: 3011, deploy_script: 'npm ci\nnpm run build:production' }
  const updated = { ...project, ...resolveCheckoutCommands(project, 'angular') }
  assert.equal(updated.project_type, 'angular')
  assert.equal(updated.start_cmd, null)
  assert.equal(updated.install_cmd, null)
  assert.equal(updated.build_cmd, 'npm run build -- --configuration production')
  assert.equal(updated.port, 3011)
  assert.equal(updated.deploy_script, project.deploy_script)
  assert.equal(resolveCheckoutCommands(project, 'next'), project)
  assert.equal(resolveCheckoutCommands(project, undefined), project)
  assert.throws(() => resolveCheckoutCommands({ ...project, start_cmd: 'custom.exe' }, 'angular'), /custom commands/)
  assert.throws(() => resolveCheckoutCommands({ ...project, project_type: 'node' }, 'angular'), /configured as node/)
})

test('checks manifests and actual write access without changing environment or lockfiles', async t => {
  const root = await fixture(t, { ...npmFiles, 'angular.json': '{}' })
  const before = await readdir(root)
  const messages: string[] = []
  await prepareProjectCheckout(root, 'angular', message => { messages.push(message) })
  assert.deepEqual(await readdir(root), before)
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), npmFiles['.env'])
  assert.equal(await readFile(path.join(root, 'package-lock.json'), 'utf8'), npmFiles['package-lock.json'])
  assert.match(messages.join(''), /Preserving .env/)
  await assert.rejects(prepareProjectCheckout(root, 'go', () => {}), /missing go.mod/)
})

test('default npm installs use committed locks and include build dependencies', async t => {
  for (const type of ['next', 'node', 'angular']) assert.equal(getProjectTypeDefaults(type).installCmd, null)
  assert.equal(await defaultInstallCommand(await fixture(t, npmFiles), 'angular'), 'npm ci --include=dev')
  assert.equal(await defaultInstallCommand(await fixture(t, { 'npm-shrinkwrap.json': '{}' }), 'next'), 'npm ci --include=dev')
  assert.equal(await defaultInstallCommand(await fixture(t), 'node'), 'npm install --include=dev')
  assert.equal(await defaultInstallCommand(await fixture(t), 'go'), 'go mod download')
})

test('Angular defaults build for production and use Manager static serving', () => {
  const defaults = getProjectTypeDefaults('angular')
  assert.equal(defaults.buildCmd, 'npm run build -- --configuration production')
  assert.equal(defaults.startCmd, null)
})

test('loading and saving project settings preserves null command overrides', () => {
  const form = getProjectCommandOverrides({ install_cmd: null, build_cmd: null, start_cmd: null })
  assert.deepEqual(form, { installCmd: '', buildCmd: '', startCmd: '' })
  assert.deepEqual(Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim() || null])), {
    installCmd: null, buildCmd: null, startCmd: null,
  })
  assert.deepEqual(getProjectCommandOverrides({ install_cmd: 'npm install --legacy-peer-deps', build_cmd: 'npm run custom-build', start_cmd: 'node server.js' }), {
    installCmd: 'npm install --legacy-peer-deps', buildCmd: 'npm run custom-build', startCmd: 'node server.js',
  })
})

test('matching project types retain explicit commands and intentionally empty overrides', () => {
  const project = { project_type: 'angular' as const, install_cmd: 'custom-install.cmd', build_cmd: '', start_cmd: 'node custom-server.js' }
  assert.equal(resolveCheckoutCommands(project, 'angular'), project)
})

test('recovery recognizes only standalone, local dependency installs', () => {
  assert.equal(localNpmInstall('npm ci --include=dev'), 'ci')
  assert.equal(localNpmInstall('npm.cmd install --no-audit'), 'install')
  assert.equal(localNpmInstall('npm i'), 'install')
  for (const command of ['npm ci && npm run build', 'npm install package', 'npm install -g', 'npm install --global', 'npm ci --prefix=../other', 'npm ci --workspace=app', 'npm ci --location=global', 'npm install --package-lock-only', 'npm run build', 'pnpm install', 'npm install\nnpm test']) {
    assert.equal(localNpmInstall(command), undefined, command)
  }
})

test('filesystem failures must refer to this checkout dependency tree', async t => {
  const root = await fixture(t)
  assert.equal(isDependencyCleanupFailure(cleanupError(root).output, root), true)
  for (const code of ['EPERM', 'EBUSY']) assert.equal(isDependencyCleanupFailure(cleanupError(root).output.replace('ENOTEMPTY', code), root), true)
  assert.equal(isDependencyCleanupFailure(`ENOTEMPTY rmdir ${path.join(root, 'node_modules')}\n`, root), true)
  assert.equal(isDependencyCleanupFailure(`ENOTEMPTY rmdir ${path.join(root, 'node_modules-other')}\n`, root), false)
  assert.equal(isDependencyCleanupFailure(cleanupError(`${root}-other`).output, root), false)
  assert.equal(isDependencyCleanupFailure('npm error ERESOLVE', root), false)
  assert.equal(isDependencyCleanupFailure(`npm error ENOTEMPTY at ${root}`, root), false)
})

test('successful installs and non-cleanup errors never reset dependencies or retry', async t => {
  const root = await fixture(t, npmFiles)
  for (const result of [ok, { code: 1, output: 'npm error EUSAGE lockfile mismatch' }, { code: 1, output: 'npm error ERESOLVE' }]) {
    let calls = 0
    assert.equal(await runPreparedDeploymentCommand('npm ci', root, async () => { calls++; return result }, () => {}), result)
    assert.equal(calls, 1)
    assert.equal(await readFile(path.join(root, 'node_modules', 'old.txt'), 'utf8'), 'old dependencies')
  }
})

test('cleanup failure moves only node_modules and retries the exact command once', async t => {
  const root = await fixture(t, npmFiles)
  const messages: string[] = []
  let calls = 0
  const command = 'npm ci --include=dev'
  const result = await runPreparedDeploymentCommand(command, root, async actual => {
    assert.equal(actual, command)
    if (++calls === 1) return cleanupError(root)
    await assert.rejects(readFile(path.join(root, 'node_modules', 'old.txt')), { code: 'ENOENT' })
    const retained = (await readdir(root)).filter(name => name.startsWith('.manager-node_modules-'))
    assert.equal(retained.length, 1)
    assert.equal(await readFile(path.join(root, retained[0], 'old.txt'), 'utf8'), 'old dependencies')
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'node_modules', 'new.txt'), 'new dependencies')
    return ok
  }, message => { messages.push(message) })
  assert.equal(result, ok)
  assert.equal(calls, 2)
  assert.equal((await readdir(root)).some(name => name.startsWith('.manager-node_modules-')), false)
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), npmFiles['.env'])
  assert.equal(await readFile(path.join(root, 'package-lock.json'), 'utf8'), npmFiles['package-lock.json'])
  assert.match(messages.join(''), /Clean dependency installation succeeded/)
})

test('a failed retry stops and retains the old dependency tree for inspection', async t => {
  const root = await fixture(t, npmFiles)
  let calls = 0
  const result = await runPreparedDeploymentCommand('npm install', root, async () => { calls++; return cleanupError(root) }, () => {})
  assert.equal(result.code, 1)
  assert.equal(calls, 2)
  const retained = (await readdir(root)).find(name => name.startsWith('.manager-node_modules-'))!
  assert.ok(retained)
  assert.equal(await readFile(path.join(root, retained, 'old.txt'), 'utf8'), 'old dependencies')
})

test('linked dependency trees are never moved or recursively deleted', async t => {
  const external = await fixture(t, { 'keep.txt': 'untouched' })
  const root = await fixture(t, { 'package.json': '{}', 'package-lock.json': '{}' })
  await symlink(external, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  let calls = 0
  await assert.rejects(runPreparedDeploymentCommand('npm ci', root, async () => { calls++; return cleanupError(root) }, () => {}), /linked/)
  assert.equal(calls, 1)
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'untouched')
})

test('npm ci without a lockfile fails before launching the installer', async t => {
  const root = await fixture(t, { 'package.json': '{}' })
  let calls = 0
  await assert.rejects(runPreparedDeploymentCommand('npm ci', root, async () => { calls++; return ok }, () => {}), /requires a committed/)
  assert.equal(calls, 0)
})

test('cancellation after the initial error prevents dependency recovery', async t => {
  const root = await fixture(t, npmFiles)
  let cancelled = false
  await assert.rejects(runPreparedDeploymentCommand('npm ci', root, async () => {
    cancelled = true
    return cleanupError(root)
  }, () => {}, () => { if (cancelled) throw new Error('cancelled') }), /cancelled/)
  assert.equal(await readFile(path.join(root, 'node_modules', 'old.txt'), 'utf8'), 'old dependencies')
})
