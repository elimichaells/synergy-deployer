import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DeploymentRelease, retainedPaths } from '../lib/deployment-release'

async function fixture(t: any, laravel = false, trackedAssets = false, activationMode?: 'directory' | 'contents') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'manager-release-test-'))
  t.after(async () => { assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }) })
  const root = path.join(directory, 'application')
  await mkdir(path.join(root, '.git'), { recursive: true })
  await mkdir(path.join(root, 'uploads'))
  await mkdir(path.join(root, 'storage/framework'), { recursive: true })
  await mkdir(path.join(root, 'node_modules'))
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'index.js'), 'old release')
  await writeFile(path.join(root, '.env'), 'APP_SECRET=fixture-private')
  await writeFile(path.join(root, 'uploads/document.txt'), 'original document')
  await writeFile(path.join(root, 'storage/framework/.gitignore'), '*\n!.gitignore\n')
  await writeFile(path.join(root, 'node_modules/package'), 'old dependencies')
  if (laravel) {
    await writeFile(path.join(root, 'artisan'), '<?php')
    await mkdir(path.join(root, 'public/build'), { recursive: true })
    await mkdir(path.join(root, 'bootstrap/cache'), { recursive: true })
    await writeFile(path.join(root, 'public/build/manifest.json'), 'old assets')
    await writeFile(path.join(root, 'bootstrap/cache/config.php'), 'old cached configuration')
    await writeFile(path.join(root, 'bootstrap/cache/.gitignore'), '*\n!.gitignore\n')
  }
  const commands: string[] = []
  const execute = async (command: string) => { commands.push(command); return { code: 0, output: command === 'git ls-files -z' ? 'index.js\0storage/framework/.gitignore\0' +
    (laravel ? 'artisan\0bootstrap/cache/.gitignore\0' : '') + (trackedAssets ? 'public/build/manifest.json\0' : '')
    : command.includes('--ignored') ? '.env\0uploads/\0node_modules/\0dist/\0' + (laravel ? (trackedAssets ? '' : 'public/build/\0') + 'bootstrap/cache/config.php\0' : '') : '' } }
  const release = new DeploymentRelease(root, 'project-1', 'deployment-1', { activationMode })
  await release.prepare(execute)
  return { root, release, directory, execute, commands }
}

test('candidate preparation keeps live files unchanged and excludes mutable data and dependencies', async t => {
  const { root, release, commands } = await fixture(t)
  if (process.platform === 'win32') {
    const acl = commands.find(command => command.startsWith('icacls '))
    assert.ok(acl?.includes(`"${release.base}"`))
    assert.ok(!acl?.includes(`"${path.dirname(release.base)}"`))
  }
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'old release')
  assert.equal(await readFile(path.join(release.candidate, '.env'), 'utf8'), 'APP_SECRET=fixture-private')
  assert.equal(await readFile(path.join(release.candidate, 'storage/framework/.gitignore'), 'utf8'), '*\n!.gitignore\n')
  await assert.rejects(lstat(path.join(release.candidate, 'node_modules')))
  await assert.rejects(lstat(path.join(release.candidate, 'uploads/document.txt')))
})

test('activation retains files written during build and rollback restores previous source', async t => {
  const { root, release } = await fixture(t)
  await writeFile(path.join(release.candidate, 'index.js'), 'new release')
  await writeFile(path.join(root, 'uploads/new.txt'), 'written while building')
  await release.activate()
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'new release')
  assert.equal(await readFile(path.join(root, 'uploads/new.txt'), 'utf8'), 'written while building')
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'APP_SECRET=fixture-private')
  await writeFile(path.join(root, 'uploads/after-start.txt'), 'keep after failed health')
  await release.rollback()
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'old release')
  assert.equal(await readFile(path.join(root, 'uploads/after-start.txt'), 'utf8'), 'keep after failed health')
  assert.equal(JSON.parse(await readFile(path.join(release.base, 'release.json'), 'utf8')).phase, 'rolled-back')
})

test('activation rebases internal Next.js package links and rollback makes the candidate inspectable', async t => {
  const { root, release } = await fixture(t)
  const packageRoot = path.join(release.candidate, 'node_modules', '@prisma', 'adapter-pg')
  const linksRoot = path.join(release.candidate, '.next', 'node_modules', '@prisma')
  const link = path.join(linksRoot, 'adapter-pg-build-id')
  await mkdir(packageRoot, { recursive: true })
  await mkdir(linksRoot, { recursive: true })
  await writeFile(path.join(packageRoot, 'package.json'), '{}')
  await symlink(packageRoot, link, process.platform === 'win32' ? 'junction' : 'dir')

  await release.activate()
  const activeLink = path.join(root, '.next', 'node_modules', '@prisma', 'adapter-pg-build-id')
  assert.equal(path.resolve(await readlink(activeLink)), path.join(root, 'node_modules', '@prisma', 'adapter-pg'))
  assert.equal(await readFile(path.join(activeLink, 'package.json'), 'utf8'), '{}')

  await release.rollback()
  const retainedLink = path.join(release.candidate, '.next', 'node_modules', '@prisma', 'adapter-pg-build-id')
  assert.equal(path.resolve(await readlink(retainedLink)), path.join(release.candidate, 'node_modules', '@prisma', 'adapter-pg'))
  assert.equal(await readFile(path.join(retainedLink, 'package.json'), 'utf8'), '{}')
})

test('partial activation can be recovered without deleting either release', async t => {
  const { root, release } = await fixture(t)
  // Force a name collision before the original source is moved.
  await mkdir(release.previous)
  await writeFile(path.join(release.previous, 'occupied'), 'keep')
  await assert.rejects(release.activate())
  await release.rollback()
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'old release')
  assert.equal(await readFile(path.join(release.previous, 'occupied'), 'utf8'), 'keep')
})

test('a completed release keeps the old source and an interrupted activation blocks the next deploy', async t => {
  const { root, release, execute } = await fixture(t)
  await release.activate()
  const next = new DeploymentRelease(root, 'project-1', 'deployment-2')
  await assert.rejects(next.prepare(execute), /interrupted release/)
  await release.complete()
  assert.equal(await readFile(path.join(release.previous, 'index.js'), 'utf8'), 'old release')
})

test('persistent paths are deduplicated and cannot escape the application', () => {
  assert.deepEqual(retainedPaths(['uploads/', 'uploads/a', 'storage', 'node_modules/', '.env', '.manager-backup/']), ['.env', 'storage', 'uploads'])
  for (const value of ['../outside', 'C:/outside', '/outside', 'uploads/../../escape']) assert.throws(() => retainedPaths([value]))
})

test('whole-directory activation remains reversible on platforms using that strategy', async t => {
  const { root, release } = await fixture(t, false, false, 'directory')
  await writeFile(path.join(release.candidate, 'index.js'), 'new release')
  await release.activate()
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'new release')
  await writeFile(path.join(root, 'uploads/during-health.txt'), 'keep this')
  await release.rollback()
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'old release')
  assert.equal(await readFile(path.join(root, 'uploads/during-health.txt'), 'utf8'), 'keep this')
})

test('Laravel activates newly built assets and cache while preserving old versions for rollback', async t => {
  const { root, release } = await fixture(t, true)
  await assert.rejects(lstat(path.join(release.candidate, 'public/build/manifest.json')))
  await assert.rejects(lstat(path.join(release.candidate, 'bootstrap/cache/config.php')))
  await mkdir(path.join(release.candidate, 'public/build'), { recursive: true })
  await writeFile(path.join(release.candidate, 'public/build/manifest.json'), 'new assets')
  await writeFile(path.join(release.candidate, 'bootstrap/cache/config.php'), 'new cached configuration')
  await release.activate()
  assert.equal(await readFile(path.join(root, 'public/build/manifest.json'), 'utf8'), 'new assets')
  assert.equal(await readFile(path.join(root, 'bootstrap/cache/config.php'), 'utf8'), 'new cached configuration')
  await release.rollback()
  assert.equal(await readFile(path.join(root, 'public/build/manifest.json'), 'utf8'), 'old assets')
  assert.equal(await readFile(path.join(root, 'bootstrap/cache/config.php'), 'utf8'), 'old cached configuration')
})

test('explicitly Git-tracked Laravel assets remain source files instead of disappearing during preparation', async t => {
  const { release } = await fixture(t, true, true)
  assert.equal(await readFile(path.join(release.candidate, 'public/build/manifest.json'), 'utf8'), 'old assets')
  assert.equal(await readFile(path.join(release.candidate, 'bootstrap/cache/.gitignore'), 'utf8'), '*\n!.gitignore\n')
})
