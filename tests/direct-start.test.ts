import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { directStartCommand, planDirectStart, type DirectStartInput } from '../lib/direct-start'
import { appsToSleep, normalizeWakeHost, sleepLabel, validateSleepAfter } from '../lib/staging-sleep-policy'

const root = path.join('C:', 'web', 'production', 'app')
const input = (overrides: Partial<DirectStartInput> & { files?: Record<string, string> } = {}): DirectStartInput => {
  const files = overrides.files ?? { [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next')]: '', [path.join(root, 'server.js')]: 'require("http").createServer().listen(process.env.PORT)' }
  return {
    startCmd: 'npm start', projectType: 'next', port: 3007, nodePinned: false, root,
    scripts: { start: 'next start' }, exists: file => file in files, read: file => files[file] ?? null, join: (...parts) => path.join(...parts),
    ...overrides,
  }
}

test('npm start running "next start" becomes Next.js started directly on the assigned port', () => {
  const plan = planDirectStart(input({ scripts: { start: 'next start -p 3000 -H 0.0.0.0' } }))
  assert.ok(plan.direct)
  assert.equal(plan.direct.script, path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'))
  assert.deepEqual(plan.direct.args, ['start', '-H', '0.0.0.0', '-p', '3007'])
  assert.equal(directStartCommand(plan.direct, 'bayport-risv2-0'), `pm2 start "${plan.direct.script}" --interpreter node --name "bayport-risv2-0" --kill-timeout 15000 -- start -H 0.0.0.0 -p 3007`)
})

test('cross-env variables and node flags are kept as environment', () => {
  const crossEnv = planDirectStart(input({ scripts: { start: 'cross-env NODE_OPTIONS=--enable-source-maps next start' } }))
  assert.deepEqual(crossEnv.direct?.env, { NODE_OPTIONS: '--enable-source-maps' })
  const flags = planDirectStart(input({ startCmd: 'node --enable-source-maps server.js --verbose' }))
  assert.deepEqual(flags.direct?.env, { NODE_OPTIONS: '--enable-source-maps' })
  assert.deepEqual(flags.direct?.args, ['--verbose'])
  assert.equal(flags.direct?.script, path.join(root, 'server.js'))
})

test('a script without an extension and a native executable can start directly', () => {
  const files = { [path.join(root, 'dist', 'index.js')]: 'console.log(1)', [path.join(root, 'app.exe')]: '' }
  assert.equal(planDirectStart(input({ files, scripts: { start: 'node dist/index' } })).direct?.script, path.join(root, 'dist', 'index.js'))
  const exe = planDirectStart(input({ files, startCmd: '.\\app.exe', projectType: 'go' }))
  assert.equal(exe.direct?.interpreter, 'none')
  assert.equal(exe.direct?.script, path.join(root, 'app.exe'))
})

test('anything npm or a shell would do differently keeps the runner, with a reason', () => {
  const reason = (overrides: Partial<DirectStartInput> & { files?: Record<string, string> }) => planDirectStart(input(overrides)).reason
  assert.match(reason({ scripts: { prestart: 'prisma generate', start: 'next start' } })!, /prestart/)
  assert.match(reason({ scripts: { start: 'next build && next start' } })!, /shell features/)
  assert.match(reason({ startCmd: 'node "my server.js"' })!, /shell features/)
  assert.match(reason({ nodePinned: true })!, /Node.js version/)
  assert.match(reason({ projectType: 'laravel', startCmd: 'php artisan serve' })!, /PHP/)
  assert.match(reason({ scripts: {} })!, /no "start" script/)
  assert.match(reason({ scripts: null })!, /could not be read/)
  assert.match(reason({ scripts: { start: 'next dev' } })!, /Only "next start"/)
  assert.match(reason({ startCmd: 'node missing.js' })!, /does not exist/)
  assert.match(reason({ startCmd: 'serve -s build' })!, /not a program that can run directly/)
  const spawner = { [path.join(root, 'start.mjs')]: 'import { spawn } from "node:child_process"; spawn(process.execPath, [])' }
  assert.match(reason({ files: spawner, startCmd: 'node start.mjs' })!, /starts another process/)
})

test('staging sleep choices, labels and idle rules', () => {
  assert.equal(validateSleepAfter(''), null)
  assert.equal(validateSleepAfter(60), 60)
  assert.throws(() => validateSleepAfter(45), /Choose one of/)
  assert.equal(sleepLabel(30), 'After 30 minutes idle')
  assert.equal(sleepLabel(60), 'After 1 hour idle')
  assert.equal(sleepLabel(120), 'After 2 hours idle')
  const now = Date.parse('2026-10-03T12:00:00Z')
  const base = { projectId: 'a', environment: 'staging', sleepAfterMinutes: 60, running: true, sleepingSince: null, lastActiveAt: '2026-10-03T10:30:00Z', lastDeployAt: '2026-10-01T10:00:00Z', deploying: false }
  assert.deepEqual(appsToSleep([base], now).map(app => app.projectId), ['a'])
  assert.deepEqual(appsToSleep([{ ...base, lastActiveAt: '2026-10-03T11:30:00Z' }], now), [], 'used half an hour ago')
  assert.deepEqual(appsToSleep([{ ...base, lastDeployAt: '2026-10-03T11:45:00Z' }], now), [], 'deployed a quarter of an hour ago')
  assert.deepEqual(appsToSleep([{ ...base, environment: 'production' }], now), [], 'production never sleeps')
  assert.deepEqual(appsToSleep([{ ...base, deploying: true }], now), [])
  assert.deepEqual(appsToSleep([{ ...base, running: false }], now), [])
  assert.deepEqual(appsToSleep([{ ...base, lastActiveAt: null, lastDeployAt: null }], now), [], 'no record of use yet')
})

test('the public wake page only accepts plain host names', () => {
  assert.equal(normalizeWakeHost('Staging-Flowbase.Example.com:443'), 'staging-flowbase.example.com')
  assert.equal(normalizeWakeHost('localhost'), null)
  assert.equal(normalizeWakeHost('a.example.com/../admin'), null)
  assert.equal(normalizeWakeHost("x.example.com' or 1=1"), null)
  assert.equal(normalizeWakeHost(42), null)
})
