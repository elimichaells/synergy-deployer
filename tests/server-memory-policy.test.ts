import assert from 'node:assert/strict'
import test from 'node:test'
import { attributeMemory, downsample, evaluateMemory, heapLimitFor, lowMemoryThreshold, suggestMemoryLimit, validateMemoryLimit, withHeapLimit, type MemorySample } from '../lib/server-memory-policy'

const MB = 1024 * 1024
const proc = (pid: number, ppid: number, name: string, privateMb: number, started = 1000) => ({ pid, ppid, name, privateBytes: privateMb * MB, workingBytes: privateMb * MB / 2, started })

test('every process in an app tree is charged to that app, including the runner chain', () => {
  const processes = [
    proc(1, 0, 'pm2-daemon.exe', 80),
    proc(10, 1, 'node.exe', 60), proc(11, 10, 'cmd.exe', 2), proc(12, 11, 'node.exe', 55), proc(13, 12, 'cmd.exe', 2), proc(14, 13, 'node.exe', 400),
    proc(20, 1, 'node.exe', 150),
    proc(30, 0, 'mysqld.exe', 800), proc(31, 0, 'svchost.exe', 5), proc(32, 0, 'svchost.exe', 7),
  ]
  const { apps, others } = attributeMemory(processes, new Map([[10, 'synergyos'], [20, 'exceedwebsite']]))
  assert.deepEqual(apps.map(app => [app.name, app.privateMb, app.processes]), [['synergyos', 519, 5], ['exceedwebsite', 150, 1]])
  assert.deepEqual(others.map(item => [item.name, item.privateMb, item.count]), [['mysqld', 800, 1], ['pm2-daemon', 80, 1], ['svchost', 12, 2]])
})

test('a process whose parent id was reused by a newer process is not charged to it', () => {
  const processes = [proc(10, 0, 'node.exe', 60, 5000), proc(50, 10, 'explorer.exe', 900, 100)]
  const { apps, others } = attributeMemory(processes, new Map([[10, 'app']]))
  assert.equal(apps[0].privateMb, 60)
  assert.deepEqual(others.map(item => item.name), ['explorer'])
})

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 3, 12, 0) + minutes * 60_000).toISOString()
const sample = (minutes: number, availableMb: number, apps: Record<string, number> = {}, commitMb = 8000): MemorySample => ({
  takenAt: at(minutes), totalMb: 16000, availableMb, commitMb, commitLimitMb: 20000, apps: Object.entries(apps).map(([name, privateMb]) => ({ name, privateMb })) })

test('low memory is reported only after three samples in a row, and is critical under five percent', () => {
  assert.equal(lowMemoryThreshold(16000), 1600)
  assert.equal(lowMemoryThreshold(8000), 1536)
  assert.deepEqual(evaluateMemory([sample(0, 1000), sample(1, 5000), sample(2, 1000)], new Map()), [])
  const low = evaluateMemory([sample(0, 1500), sample(1, 1400), sample(2, 1200)], new Map())
  assert.equal(low.length, 1)
  assert.equal(low[0].kind, 'low_memory')
  assert.equal(low[0].level, 'warning')
  assert.match(low[0].message, /Only 1\.2 GB of 15\.6 GB/)
  assert.equal(evaluateMemory([sample(0, 700), sample(1, 700), sample(2, 700)], new Map())[0].level, 'error')
  assert.deepEqual(evaluateMemory([sample(0, 1000), sample(1, 1000)], new Map()), [], 'two samples are not enough')
})

test('commit close to its limit, and an app over its own limit, are reported with readable names', () => {
  const commit = evaluateMemory([sample(0, 5000, {}, 18500), sample(1, 5000, {}, 18200), sample(2, 5000, {}, 18100)], new Map())
  assert.deepEqual(commit.map(item => [item.kind, item.level]), [['commit_high', 'error']])
  const limits = new Map([['owner.trueid.info', 512]])
  const over = evaluateMemory([sample(0, 5000, { 'owner.trueid.info': 600 }), sample(1, 5000, { 'owner.trueid.info': 650 }), sample(2, 5000, { 'owner.trueid.info': 700 })], limits, new Map([['owner.trueid.info', 'Owner portal']]))
  assert.equal(over.length, 1)
  assert.equal(over[0].subject, 'owner.trueid.info')
  assert.match(over[0].message, /^Owner portal uses 700 MB|^Owner portal uses 0\.7 GB/)
  assert.deepEqual(evaluateMemory([sample(0, 5000, { 'owner.trueid.info': 600 }), sample(1, 5000, { 'owner.trueid.info': 400 }), sample(2, 5000, { 'owner.trueid.info': 700 })], limits), [])
})

test('steady growth over six hours is reported as a possible leak; small or short changes are not', () => {
  const earlier = [358, 359, 360].map(minutes => sample(minutes, 6000, { flowbase: 400, tiny: 100 }))
  const now = [718, 719, 720].map(minutes => sample(minutes, 6000, { flowbase: 900, tiny: 250 }))
  const grown = evaluateMemory([...earlier, ...now], new Map())
  assert.deepEqual(grown.map(item => [item.kind, item.subject]), [['app_growing', 'flowbase']])
  assert.match(grown[0].message, /grew from 0\.4 GB to 0\.9 GB in six hours/)
  assert.deepEqual(evaluateMemory(now, new Map()), [], 'no samples from six hours ago means no growth judgement')
})

test('suggested limits leave room above the peak; limits are validated against the server', () => {
  assert.equal(suggestMemoryLimit(100, 120), 512)
  assert.equal(suggestMemoryLimit(1030, 1100), 1792)
  assert.equal(validateMemoryLimit('', 16000), null)
  assert.equal(validateMemoryLimit(null, 16000), null)
  assert.equal(validateMemoryLimit(1024, 16000), 1024)
  assert.throws(() => validateMemoryLimit(100, 16000), /at least 256 MB/)
  assert.throws(() => validateMemoryLimit(1.5, 16000), /whole number/)
  assert.throws(() => validateMemoryLimit(20000, 16000), /cannot be more than the server/)
})

test('the heap cap replaces any earlier cap and keeps the app\'s other Node options', () => {
  assert.equal(heapLimitFor(1024), 768)
  assert.equal(heapLimitFor(256), 192)
  assert.equal(withHeapLimit(undefined, 1024), '--max-old-space-size=768')
  assert.equal(withHeapLimit('--enable-source-maps --max-old-space-size=4096', 2048), '--enable-source-maps --max-old-space-size=1536')
  assert.equal(withHeapLimit('--enable-source-maps --max-old-space-size=4096', null), '--enable-source-maps')
})

test('history is thinned for charts without hiding the lowest points', () => {
  const history = Array.from({ length: 100 }, (_, index) => ({ availableMb: index === 37 ? 10 : 5000, index }))
  const thinned = downsample(history, 10)
  assert.equal(thinned.length, 10)
  assert.ok(thinned.some(point => point.availableMb === 10))
  assert.equal(downsample(history.slice(0, 5), 10).length, 5)
})
