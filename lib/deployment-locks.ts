import { execFile } from 'node:child_process'
import path from 'node:path'

export interface DirectoryHandleReport {
  owners: Array<{ pid: number; name: string }>
  truncated: boolean
  unavailable: number
}

export async function inspectProjectDirectoryHandles(root: string): Promise<DirectoryHandleReport> {
  if (process.platform !== 'win32') return { owners: [], truncated: false, unavailable: 0 }
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), 'scripts', 'inspect-deployment-directories.ps1')],
      { cwd: process.cwd(), windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) reject(new Error('Directory handle inspection unavailable'))
        else resolve(stdout)
      })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify({ root }))
  })
  const report = JSON.parse(output.replace(/^\uFEFF/, '')) as DirectoryHandleReport
  if (!Array.isArray(report.owners) || report.owners.length > 50 || !report.owners.every(owner => Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.name === 'string')
    || typeof report.truncated !== 'boolean' || !Number.isSafeInteger(report.unavailable) || report.unavailable < 0) throw new Error('Invalid directory handle report')
  return report
}

export function formatDirectoryHandleReport(report: DirectoryHandleReport) {
  // Filenames are controlled by the process owner; prevent log/control injection.
  const owners = report.owners.map(owner => `${owner.name.replace(/[^a-zA-Z0-9._ -]/g, '?').slice(0, 80)} (PID ${owner.pid})`)
  const coverage = report.unavailable ? ` ${report.unavailable} processes could not be inspected.` : ''
  if (!owners.length) return `[process] No project directory handles were identified.${coverage} File locks or permissions may still block the rename.\n`
  return `[process] Processes with project directories open: ${owners.join(', ')}${report.truncated ? ', ...' : ''}.${coverage}\n`
    + '[process] These are directory-handle owners, not confirmed exclusive blockers. Save and close relevant editor files or move Explorer windows outside the project. Editors, shared hosts, and Manager are not force-closed.\n'
}

export async function logProjectDirectoryHandles(root: string, append: (message: string) => void | Promise<void>) {
  try { await append(formatDirectoryHandleReport(await inspectProjectDirectoryHandles(root))) }
  catch { await append('[process] Remaining directory handles could not be inspected; lock ownership is unknown\n') }
}
