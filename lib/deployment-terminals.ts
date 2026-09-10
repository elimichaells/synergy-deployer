import { execFile } from 'node:child_process'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { listWindowsProcesses, type WindowsProcess } from './deployment-processes'
import { logProjectDirectoryHandles } from './deployment-locks'

// Only plain interactive shells qualify. Script runners, editors, terminal hosts,
// Manager's ancestors and shells with workload children must never be terminated here.
export function terminalCandidates(all: WindowsProcess[], managerPid: number) {
  const protectedPids = new Set<number>()
  let current = all.find(item => item.pid === managerPid)
  if (!current) return [] // Cannot establish Manager's ancestry.
  while (current && !protectedPids.has(current.pid)) {
    protectedPids.add(current.pid)
    const child: WindowsProcess = current
    current = all.find(item => item.pid === child.parentPid && item.created <= child.created)
  }
  return all.filter(item => {
    if (protectedPids.has(item.pid) || !item.commandLine || !/^(cmd|powershell|pwsh)\.exe$/i.test(item.name)) return false
    if (all.some(child => child.parentPid === item.pid && child.created >= item.created && !/^conhost\.exe$/i.test(child.name))) return false
    const args = item.commandLine.match(/"[^"]*"|[^\s"]+/g) || []
    const allowed = /^cmd\.exe$/i.test(item.name) ? /^\/(d|q|a|u)$/i : /^-(NoLogo|NoProfile|NoExit)$/i
    return args.length > 0 && args.slice(1).every(arg => allowed.test(arg))
  })
}

export async function recoverProjectTerminalLocks(root: string, append: (message: string) => void | Promise<void>) {
  if (process.platform !== 'win32') return
  const project = await realpath(root)
  const manager = await realpath(process.cwd())
  const relative = path.relative(project, manager)
  if (project === path.parse(project).root || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Refusing terminal recovery for Manager or its parent directory')
  }
  await append('[process] Release rename is blocked; checking dedicated terminal directory handles\n')
  try {
    const candidates = terminalCandidates(await listWindowsProcesses(), process.pid)
    if (!candidates.length) {
      await append('[process] No eligible dedicated terminals; shared hosts and shells with running child commands are protected\n')
      return
    }
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(manager, 'scripts', 'close-deployment-terminals.ps1')],
        { cwd: manager, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error) reject(new Error('Terminal handle inspection was unavailable'))
          else resolve(stdout)
        })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify({ root: project, managerPid: process.pid, candidates }))
    })
    const result: { stopped: number[] } = JSON.parse(output.replace(/^\uFEFF/, ''))
    if (!Array.isArray(result.stopped) || !result.stopped.every(pid => Number.isSafeInteger(pid) && candidates.some(item => item.pid === pid))) throw new Error('Invalid terminal recovery response')
    await append(result.stopped.length
      ? `[process] Closed dedicated terminals holding project directories (PIDs: ${result.stopped.join(', ')}); retrying release rename\n`
      : '[process] No eligible terminal directory handles could be closed; retrying release rename\n')
  } catch {
    // Command lines and native exception details may contain credentials.
    await append('[process] Terminal recovery could not be completed; retrying rename with rollback protection\n')
  } finally {
    // A lack of eligible terminals does not mean the directory is unlocked.
    // Editors, Explorer and even Manager can own handles; identify them without
    // broadening the set of processes automatic recovery may terminate.
    await logProjectDirectoryHandles(project, append)
  }
}
