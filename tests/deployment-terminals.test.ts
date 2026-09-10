import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalCandidates } from '../lib/deployment-terminals'
import { renameReleasePath } from '../lib/deployment-filesystem'
import type { WindowsProcess } from '../lib/deployment-processes'

const proc = (pid: number, parentPid: number, name = 'cmd.exe', commandLine = name): WindowsProcess => ({
  pid, parentPid, name, commandLine, created: '20260908070000000',
})

test('terminal selection protects Manager ancestry, shared hosts, active commands and other shells with children', () => {
  const rows = [proc(1, 0), proc(2, 1, 'node.exe'), proc(3, 0, 'WindowsTerminal.exe'),
    proc(4, 3), proc(5, 3, 'powershell.exe', 'powershell.exe -NoLogo -NoProfile'),
    proc(6, 3, 'cmd.exe', 'cmd.exe /c deploy.cmd'), proc(7, 3), proc(8, 7, 'node.exe'),
    proc(9, 3, 'pwsh.exe', 'pwsh.exe -EncodedCommand secret'), proc(10, 3, 'code.exe'),
    proc(11, 3, 'powershell.exe', 'powershell.exe -File script.ps1'),
    proc(12, 3, 'cmd.exe', 'cmd.exe /k run-background-job.cmd'), proc(13, 4, 'conhost.exe')]
  assert.deepEqual(terminalCandidates(rows, 2).map(row => row.pid), [4, 5])
  assert.deepEqual(terminalCandidates(rows, 999), [])
  assert.deepEqual(terminalCandidates([proc(2, 0, 'node.exe'), { ...proc(4, 3), commandLine: null }], 2), [])
})

test('terminal recovery happens once after ordinary retries and only for Windows lock errors', async () => {
  const locked = Object.assign(new Error('locked'), { code: 'EBUSY' })
  let attempts = 0
  let recovered = 0
  await renameReleasePath('root', 'previous', { platform: 'win32', sleep: async () => {},
    rename: async () => { attempts++; if (!recovered) throw locked },
    recoverLock: async () => { assert.equal(attempts, 6); recovered++ },
  })
  assert.equal(attempts, 7)
  assert.equal(recovered, 1)
  attempts = 0
  recovered = 0
  await assert.rejects(renameReleasePath('root', 'previous', { platform: 'win32', sleep: async () => {},
    rename: async () => { attempts++; throw locked }, recoverLock: async () => { recovered++ },
  }), /still locked/)
  assert.equal(attempts, 7)
  assert.equal(recovered, 1)
  for (const [platform, code] of [['linux', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'EEXIST']]) {
    await assert.rejects(renameReleasePath('root', 'previous', { platform, sleep: async () => {},
      rename: async () => { throw Object.assign(new Error(code), { code }) },
      recoverLock: async () => { assert.fail('must not close terminals') },
    }), { message: code })
  }
})
