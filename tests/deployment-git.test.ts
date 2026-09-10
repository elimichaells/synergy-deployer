import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { assertCleanDeploymentCheckout, syncDeploymentCheckout } from '../lib/deployment-git'

async function fixture(t: TestContext) {
  const parent = await realpath(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'manager-git-test-'))
  t.after(async () => {
    assert.equal(path.dirname(root), parent)
    assert.ok(path.basename(root).startsWith('manager-git-test-'))
    assert.equal(await realpath(root), root)
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Manager Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (file: string, contents: string) => writeFile(path.join(root, file), contents)
  const read = (file: string) => readFile(path.join(root, file), 'utf8')
  git('init', '-q', '-b', 'deployed')
  git('config', 'core.autocrlf', 'false')
  await write('app.txt', 'original source\n')
  await write('.gitignore', '.env\nnode_modules/\n')
  git('add', 'app.txt', '.gitignore')
  git('commit', '-qm', 'fixture base')
  git('branch', 'upstream')
  const execute = async (command: string) => {
    try {
      return { code: 0, output: execSync(command, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { code: failure.status ?? 1, output: `${failure.stdout || ''}${failure.stderr || ''}` }
    }
  }
  const advance = async (file = 'app.txt', contents = 'upstream source\n') => {
    git('checkout', '-q', 'upstream')
    await write(file, contents)
    git('add', '-f', file)
    git('commit', '-qm', 'fixture upstream change')
    git('checkout', '-q', 'deployed')
  }
  return { root, git, write, read, execute, advance }
}

test('a clean checkout advances and preserves ignored env and unrelated untracked files', async t => {
  const f = await fixture(t)
  await f.advance()
  await f.write('.env', 'LOCAL_SETTING=preserve\n')
  await f.write('notes.txt', 'untracked work\n')
  await syncDeploymentCheckout('upstream', f.execute, () => {})
  assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'upstream'))
  assert.equal(await f.read('app.txt'), 'upstream source\n')
  assert.equal(await f.read('.env'), 'LOCAL_SETTING=preserve\n')
  assert.equal(await f.read('notes.txt'), 'untracked work\n')
})

test('tracked modifications are refused before checkout, without exposing their contents', async t => {
  const f = await fixture(t)
  await f.advance()
  const head = f.git('rev-parse', 'HEAD')
  await f.write('app.txt', 'local fix with private value\n')
  await assert.rejects(assertCleanDeploymentCheckout(f.execute), error => {
    assert.match(String(error), /Local source changes detected/)
    assert.match(String(error), /Changed tracked files: app\.txt/)
    assert.doesNotMatch(String(error), /private value/)
    return true
  })
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Local source changes detected/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(await f.read('app.txt'), 'local fix with private value\n')
})

test('staged edits remain staged and are not reset', async t => {
  const f = await fixture(t)
  await f.write('app.txt', 'staged fix\n')
  f.git('add', 'app.txt')
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Local source changes detected/)
  assert.equal(f.git('show', ':app.txt'), 'staged fix')
})

test('a local commit absent from the fetched target is never discarded', async t => {
  const f = await fixture(t)
  await f.write('app.txt', 'unpublished fix\n')
  f.git('add', 'app.txt')
  f.git('commit', '-qm', 'fixture unpublished fix')
  const head = f.git('rev-parse', 'HEAD')
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Local commits are missing/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(await f.read('app.txt'), 'unpublished fix\n')
})

test('a new local edit after an earlier clean check is still protected', async t => {
  const f = await fixture(t)
  await f.advance()
  await assertCleanDeploymentCheckout(f.execute)
  await f.write('app.txt', 'concurrent edit\n')
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Local source changes detected/)
  assert.equal(await f.read('app.txt'), 'concurrent edit\n')
})

test('Git refuses an incoming file that would overwrite untracked local work', async t => {
  const f = await fixture(t)
  await f.advance('notes.txt', 'upstream file\n')
  const head = f.git('rev-parse', 'HEAD')
  await f.write('notes.txt', 'local work\n')
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Checkout update refused/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(await f.read('notes.txt'), 'local work\n')
})

test('an incoming tracked env file cannot overwrite an ignored local env file', async t => {
  const f = await fixture(t)
  await f.advance('.env', 'UPSTREAM_SETTING=example\n')
  const head = f.git('rev-parse', 'HEAD')
  await f.write('.env', 'LOCAL_SETTING=preserve\n')
  await assert.rejects(syncDeploymentCheckout('upstream', f.execute, () => {}), /Checkout update refused/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(await f.read('.env'), 'LOCAL_SETTING=preserve\n')
})

test('inspection errors and unsafe targets fail closed without running a reset', async () => {
  const commands: string[] = []
  const execute = async (command: string) => { commands.push(command); return { code: 1, output: 'unavailable' } }
  await assert.rejects(syncDeploymentCheckout('upstream & echo unsafe', execute, () => {}), /Invalid deployment Git reference/)
  assert.equal(commands.length, 0)
  await assert.rejects(syncDeploymentCheckout('upstream', execute, () => {}), /Could not check local source changes/)
  assert.equal(commands.length, 1)
  await assert.rejects(syncDeploymentCheckout('upstream', async command => {
    commands.push(command)
    return { code: 0, output: command.includes('status') ? '' : 'invalid count' }
  }, () => {}), /Could not verify local Git history/)
  assert.ok(commands.every(command => !command.includes('reset')))
})
