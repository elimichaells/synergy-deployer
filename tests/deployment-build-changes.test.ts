import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classifyLocalChanges, inspectLocalChanges, localChangesMessage, parseTrackedChanges, recordBuildChanges, restoreGeneratedFiles } from '../lib/deployment-build-changes'

test('only plain edits and deletions of tracked files can be attributed to a build', () => {
  const parsed = parseTrackedChanges(' M package-lock.json\n M public/widget.js\n D old.js\nR  a.js -> b.js\nA  staged.js\nUU conflict.js\n M "odd\\tname.js"\n M ../outside.js\n')
  assert.deepEqual(parsed.paths, ['package-lock.json', 'public/widget.js', 'old.js'])
  assert.deepEqual(parsed.complex, ['a.js -> b.js', 'staged.js', 'conflict.js', '"odd\\tname.js"', '../outside.js'])
  assert.deepEqual(parseTrackedChanges(''), { paths: [], complex: [] })
})

test('with a record, a file is build output only while its content still matches what the build left', () => {
  const base = { paths: ['public/bundle.js', 'public/widget.js', 'src/app.ts'], mtimes: {}, window: null,
    hashes: { 'public/bundle.js': 'aaa', 'public/widget.js': 'edited-since', 'src/app.ts': 'ccc' } }
  const result = classifyLocalChanges({ ...base, manifest: { 'public/bundle.js': 'aaa', 'public/widget.js': 'bbb' } })
  assert.deepEqual(result.generated, ['public/bundle.js'])
  assert.deepEqual(result.unexplained, ['public/widget.js', 'src/app.ts'])
  assert.equal(result.inferred, false)
  // An empty record means the last build changed nothing, so every change is someone's edit.
  assert.deepEqual(classifyLocalChanges({ ...base, manifest: {} }).unexplained, base.paths)
})

test('without a record, only files last written during the last deployment count as build output', () => {
  const from = Date.parse('2026-08-12T15:03:00Z'); const to = Date.parse('2026-08-12T15:07:00Z')
  const result = classifyLocalChanges({ paths: ['lock', 'widget', 'edited-later', 'gone'], hashes: {}, manifest: null, window: { from, to },
    mtimes: { lock: from + 60_000, widget: to + 60_000, 'edited-later': to + 3_600_000, gone: null } })
  assert.deepEqual(result.generated, ['lock', 'widget'])
  assert.deepEqual(result.unexplained, ['edited-later', 'gone'])
  assert.equal(result.inferred, true)
  assert.deepEqual(classifyLocalChanges({ paths: ['lock'], hashes: {}, manifest: null, window: null, mtimes: { lock: from } }).unexplained, ['lock'])
})

test('an npm lockfile that changed on its own is npm output; one that changed with package.json is a person', () => {
  const alone = classifyLocalChanges({ paths: ['package-lock.json', 'api/package-lock.json', 'src/app.ts'], hashes: {}, manifest: null, window: null,
    mtimes: { 'package-lock.json': 1, 'api/package-lock.json': 1, 'src/app.ts': 1 } })
  assert.deepEqual(alone.generated, ['package-lock.json', 'api/package-lock.json'])
  assert.deepEqual(alone.unexplained, ['src/app.ts'])
  assert.equal(alone.inferred, true)
  const together = classifyLocalChanges({ paths: ['package.json', 'package-lock.json'], hashes: {}, manifest: {}, window: null, mtimes: { 'package.json': 1, 'package-lock.json': 1 } })
  assert.deepEqual(together.unexplained, ['package.json', 'package-lock.json'])
  // A deleted lockfile is not npm output.
  assert.deepEqual(classifyLocalChanges({ paths: ['package-lock.json'], hashes: {}, manifest: null, window: null, mtimes: { 'package-lock.json': null } }).unexplained, ['package-lock.json'])
  // With a record whose content no longer matches, a lone lockfile is still npm output.
  assert.deepEqual(classifyLocalChanges({ paths: ['package-lock.json'], hashes: { 'package-lock.json': 'new' }, manifest: { 'package-lock.json': 'old' }, window: null, mtimes: { 'package-lock.json': 1 } }).generated, ['package-lock.json'])
})

test('the blocking message names the files that still need a person', () => {
  assert.match(localChangesMessage(['src/app.ts']), /Changed tracked files: src\/app\.ts\. Review and commit/)
  assert.match(localChangesMessage(Array.from({ length: 10 }, (_, i) => `f${i}`)), /f7, and 2 more/)
})

test('a real checkout: build output is recorded, recognised, backed up and reset; a later edit is not', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'manager-build-changes-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const repo = path.join(base, 'app')
  await mkdir(path.join(repo, 'public'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { cwd: repo, encoding: 'utf8' })
  const execute = async (command: string) => {
    try { return { code: 0, output: execFileSync(command, { cwd: repo, encoding: 'utf8', shell: true }) } } catch (error) { return { code: 1, output: String((error as Error).message) } }
  }
  git('init', '-q')
  await writeFile(path.join(repo, 'package-lock.json'), '{"lock":1}\n')
  await writeFile(path.join(repo, 'public/widget.js'), 'widget()\n')
  await writeFile(path.join(repo, 'src.ts'), 'source\n')
  git('add', '-A'); git('commit', '-q', '-m', 'initial')

  // The "build" rewrites two committed files.
  await writeFile(path.join(repo, 'package-lock.json'), '{"lock":1,"peer":true}\n')
  await writeFile(path.join(repo, 'public/widget.js'), 'widget()\r\n')
  const manifest = await recordBuildChanges(execute, repo)
  assert.deepEqual(Object.keys(manifest).sort(), ['package-lock.json', 'public/widget.js'])

  // Next deployment: the same content is recognised; a real edit made afterwards is not.
  await writeFile(path.join(repo, 'src.ts'), 'edited by a person\n')
  const local = await inspectLocalChanges(execute, repo)
  const classified = classifyLocalChanges({ ...local, manifest, window: null })
  assert.deepEqual(classified.generated.sort(), ['package-lock.json', 'public/widget.js'])
  assert.deepEqual(classified.unexplained, ['src.ts'])

  // Resetting the generated files keeps a copy and leaves the person's edit alone.
  const backup = path.join(base, 'backup')
  await restoreGeneratedFiles(execute, repo, classified.generated, backup)
  // Git may write the platform's line endings on checkout; the content is what matters.
  assert.equal((await readFile(path.join(repo, 'package-lock.json'), 'utf8')).replace(/\r\n/g, '\n'), '{"lock":1}\n')
  assert.equal(await readFile(path.join(backup, 'public/widget.js'), 'utf8'), 'widget()\r\n')
  assert.equal(await readFile(path.join(repo, 'src.ts'), 'utf8'), 'edited by a person\n')
  assert.deepEqual((await inspectLocalChanges(execute, repo)).paths, ['src.ts'])

  // Timestamps: a file written inside the deployment window is recognised without a record.
  await writeFile(path.join(repo, 'package-lock.json'), '{"lock":2}\n')
  const when = new Date('2026-08-12T15:04:00Z')
  await utimes(path.join(repo, 'package-lock.json'), when, when)
  const again = await inspectLocalChanges(execute, repo)
  const byTime = classifyLocalChanges({ ...again, manifest: null, window: { from: Date.parse('2026-08-12T15:03:00Z'), to: Date.parse('2026-08-12T15:07:00Z') } })
  assert.deepEqual(byTime.generated, ['package-lock.json'])
  assert.deepEqual(byTime.unexplained, ['src.ts'])
  await assert.rejects(restoreGeneratedFiles(execute, repo, ['../outside']), /unsafe name/)
  assert.equal(existsSync(path.join(base, 'outside')), false)
})
