import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discardSeededCaches, seedBuildCache } from '../lib/deployment-build-cache'

async function roots(t: any) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'manager-build-cache-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const live = path.join(base, 'live')
  const candidate = path.join(base, 'candidate')
  await mkdir(candidate, { recursive: true })
  return { base, live, candidate }
}

test('the candidate starts with a copy of the live build cache, and the live cache is untouched', async t => {
  const { live, candidate } = await roots(t)
  await mkdir(path.join(live, '.next/cache/turbopack'), { recursive: true })
  await writeFile(path.join(live, '.next/cache/turbopack/pack'), 'warm')
  await writeFile(path.join(live, '.next/cache/.tsbuildinfo'), 'types')
  const messages: string[] = []
  const seeded = await seedBuildCache(live, candidate, message => { messages.push(message) })
  assert.deepEqual(seeded, [path.join(candidate, '.next/cache')])
  assert.equal(await readFile(path.join(candidate, '.next/cache/turbopack/pack'), 'utf8'), 'warm')
  assert.equal(await readFile(path.join(candidate, '.next/cache/.tsbuildinfo'), 'utf8'), 'types')
  assert.match(messages.join(''), /Reusing the build cache from the current release \(\.next\/cache/)
  await discardSeededCaches(seeded)
  assert.equal(existsSync(path.join(candidate, '.next/cache')), false)
  assert.equal(await readFile(path.join(live, '.next/cache/turbopack/pack'), 'utf8'), 'warm')
})

test('nothing is seeded when there is no cache, or the candidate already has one', async t => {
  const { live, candidate } = await roots(t)
  assert.deepEqual(await seedBuildCache(live, candidate, () => {}), [])
  await mkdir(path.join(live, '.angular/cache'), { recursive: true })
  await writeFile(path.join(live, '.angular/cache/a'), 'old')
  await mkdir(path.join(candidate, '.angular/cache'), { recursive: true })
  await writeFile(path.join(candidate, '.angular/cache/a'), 'new')
  assert.deepEqual(await seedBuildCache(live, candidate, () => {}), [])
  assert.equal(await readFile(path.join(candidate, '.angular/cache/a'), 'utf8'), 'new')
})

test('caches that are too large or contain links are skipped and the build starts from scratch', async t => {
  const { base, live, candidate } = await roots(t)
  await mkdir(path.join(live, '.next/cache'), { recursive: true })
  await writeFile(path.join(live, '.next/cache/big'), 'x'.repeat(2048))
  const messages: string[] = []
  assert.deepEqual(await seedBuildCache(live, candidate, message => { messages.push(message) }, 1024), [])
  assert.match(messages.join(''), /larger than/)
  assert.equal(existsSync(path.join(candidate, '.next/cache')), false)

  await rm(path.join(live, '.next/cache/big'))
  await mkdir(path.join(base, 'outside'))
  try { await symlink(path.join(base, 'outside'), path.join(live, '.next/cache/escape'), 'junction') } catch { return t.skip('links unavailable') }
  messages.length = 0
  assert.deepEqual(await seedBuildCache(live, candidate, message => { messages.push(message) }), [])
  assert.match(messages.join(''), /contains a link/)
  assert.equal(existsSync(path.join(candidate, '.next/cache')), false)
})
