import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDirectoryHandleReport } from '../lib/deployment-locks'

test('lock diagnostics identify non-terminal owners without claiming every handle blocks the rename', () => {
  const log = formatDirectoryHandleReport({ owners: [{ pid: 12, name: 'notepad.exe' }, { pid: 13, name: 'explorer.exe' }], truncated: false, unavailable: 2 })
  assert.match(log, /notepad.exe \(PID 12\)/)
  assert.match(log, /explorer.exe \(PID 13\)/)
  assert.match(log, /2 processes could not be inspected/)
  assert.match(log, /not confirmed exclusive blockers/)
  assert.match(log, /not force-closed/)
})

test('diagnostics sanitize process-controlled names and report incomplete or empty inspections honestly', () => {
  const log = formatDirectoryHandleReport({ owners: [{ pid: 12, name: 'bad\n[error]\u001b.exe' }], truncated: true, unavailable: 0 })
  assert.ok(!log.includes('\n[error]'))
  assert.ok(!log.includes('\u001b'))
  assert.match(log, /, \.\.\./)
  assert.match(formatDirectoryHandleReport({ owners: [], truncated: false, unavailable: 3 }), /No project directory handles were identified.*3 processes could not be inspected/)
})
