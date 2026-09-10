import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cacheEligible, dependencyCacheKey, installWithDependencyCache, assertAuditPassed, formatAuditFindings, MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES } from '../lib/deployment-cache'

test('reuse is limited to frozen local installs without source-dependent hooks or links', () => {
  assert.equal(cacheEligible('npm ci --include=dev', {}, '{}'), true)
  for (const command of ['npm install', 'npm ci && npm run build', 'npm ci --workspace=app', 'npm ci --dry-run', 'npm ci --ignore-scripts']) assert.equal(cacheEligible(command, {}, '{}'), false)
  assert.equal(cacheEligible('npm ci', { scripts: { postinstall: 'node generate.js' } }, '{}'), false)
  assert.equal(cacheEligible('npm ci', { workspaces: ['web'] }, '{}'), false)
  assert.equal(cacheEligible('npm ci', {}, '{"packages":{"lib":{"resolved":"file:../lib"}}}'), false)
  assert.equal(cacheEligible('npm ci', {}, 'x'.repeat(MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES + 1)), false)
})

test('large dependency trees use npm native cache without creating or reading a node_modules snapshot', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'manager-large-cache-test-'))
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(base, { recursive: true, force: true }) })
  const root = path.join(base, 'candidate')
  const cacheRoot = path.join(base, 'cache')
  await mkdir(root)
  await writeFile(path.join(root, 'package.json'), '{}')
  await writeFile(path.join(root, 'package-lock.json'), 'x'.repeat(MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES + 1))
  const messages: string[] = []
  let installs = 0
  const result = await installWithDependencyCache({ root, cacheRoot, command: 'npm ci', env: {},
    append: text => { messages.push(text) }, checkCancelled: () => {}, inspect: async () => { throw new Error('large snapshots must bypass inspection') },
    execute: async command => { installs++; assert.match(command, /--prefer-offline --no-audit --no-fund/); return { code: 0, output: '' } } })
  assert.equal(result.code, 0)
  assert.equal(installs, 1)
  assert.match(messages.join(''), /large dependency tree/)
  await assert.rejects(readFile(cacheRoot), { code: 'ENOENT' })
})

test('cache identity includes lock, manifest, runtime, npm, settings, and private environment without storing values', () => {
  const initial = { manifest: '{}', lock: '{}', runtime: 'node24:abi137:win32:x64', npm: '11', settings: '{}', command: 'npm ci', environment: { DB_PASSWORD: 'fixture-secret', NODE_ENV: 'development' } }
  const key = dependencyCacheKey(initial)
  for (const field of ['manifest', 'lock', 'runtime', 'npm', 'settings', 'command'] as const) assert.notEqual(key, dependencyCacheKey({ ...initial, [field]: initial[field] + 'changed' }))
  assert.notEqual(key, dependencyCacheKey({ ...initial, environment: { ...initial.environment, DB_PASSWORD: 'changed' } }))
  assert.equal(key, dependencyCacheKey({ ...initial, environment: { NODE_ENV: 'development', DB_PASSWORD: 'fixture-secret' } }))
  assert.equal(key.includes('fixture-secret'), false)
})

test('cache reuse copies verified dependencies and corruption triggers a fresh install', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'manager-cache-test-'))
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(base, { recursive: true, force: true }) })
  const cacheRoot = path.join(base, 'cache')
  let installs = 0
  const messages: string[] = []
  async function run(name: string) {
    const root = path.join(base, name)
    await mkdir(root)
    await writeFile(path.join(root, 'package.json'), '{}')
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')
    await installWithDependencyCache({ root, cacheRoot, command: 'npm ci --include=dev', env: {}, append: text => { messages.push(text) }, checkCancelled: () => {},
      inspect: async command => ({ code: 0, output: command.includes('config') ? '{}' : command.includes('node -p') ? '{"version":"24","abi":"137"}' : '11' }),
      execute: async command => {
        assert.match(command, /--prefer-offline --no-audit --no-fund/)
        installs++
        await mkdir(path.join(root, 'node_modules'), { recursive: true })
        await writeFile(path.join(root, 'node_modules/package.js'), 'verified package')
        return { code: 0, output: '' }
      } })
    return root
  }
  const first = await run('first')
  const second = await run('second')
  assert.equal(installs, 1)
  assert.ok(messages.some(message => message.includes('Verified cache hit')))
  await writeFile(path.join(second, 'node_modules/package.js'), 'build mutation')
  assert.equal(await readFile(path.join(first, 'node_modules/package.js'), 'utf8'), 'verified package')
  const { readdir } = await import('node:fs/promises')
  const key = (await readdir(cacheRoot)).find(name => /^[a-f0-9]{64}$/.test(name))!
  await writeFile(path.join(cacheRoot, key, 'node_modules/package.js'), 'corrupted cache')
  await run('third')
  assert.equal(installs, 2)
  await run('fourth')
  assert.equal(installs, 2)
})

test('security gate fails closed for critical findings, registry failure, malformed reports and failed commands', () => {
  const report = (high = 0, critical = 0) => JSON.stringify({ metadata: { vulnerabilities: { low: 2, moderate: 1, high, critical } } })
  assert.equal(assertAuditPassed({ code: 0, output: report() }).moderate, 1)
  assert.throws(() => assertAuditPassed({ code: 1, output: report(1) }), /blocked/)
  assert.throws(() => assertAuditPassed({ code: 0, output: report(0, 1) }), /blocked/)
  assert.throws(() => assertAuditPassed({ code: 1, output: report() }), /blocked/)
  for (const output of ['offline', '{}', '{"error":{"code":"ENETUNREACH"}}']) assert.throws(() => assertAuditPassed({ code: 0, output }), /blocked/)
})

test('audit details explain inherited findings, advisory links and major upgrades without trusting log control text', () => {
  const output = formatAuditFindings(JSON.stringify({ vulnerabilities: {
    '@angular/core': { severity: 'high', range: '<20.0.0', via: [
      'upstream-package', { title: 'XSS\n[stage] complete', url: 'https://github.com/advisories/GHSA-example' },
      { title: 'Unsafe URL', url: 'https://user:password@example.com/advisory' },
    ], fixAvailable: { name: '@angular/core', version: '20.3.30', isSemVerMajor: true } },
    'minor-finding': { severity: 'moderate' },
  } }))
  assert.match(output, /high: @angular\/core/)
  assert.match(output, /Via dependency: upstream-package/)
  assert.match(output, /https:\/\/github.com\/advisories\/GHSA-example/)
  assert.match(output, /major upgrade; migration and testing required/)
  assert.doesNotMatch(output, /\n\[stage\]|password|minor-finding/)
  for (const invalid of ['offline', '{}', 'null', '{"vulnerabilities":{"x":null}}']) assert.equal(formatAuditFindings(invalid), '')
})
