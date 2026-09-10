import { execFile } from 'child_process'
import path from 'path'

export interface WindowsProcess {
  pid: number
  parentPid: number
  created: string
  name: string
  commandLine: string | null
}
export interface ProcessAccess {
  list(): Promise<WindowsProcess[]>
  stop(processes: WindowsProcess[]): Promise<void>
}
export interface ProjectProcessSnapshot {
  processes: WindowsProcess[]
  laravelRoot?: string
}

function powershell(script: string, input = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        // Process command lines can contain secrets. Never include stdout/stderr in deployment errors.
        if (error) reject(new Error('Could not inspect or stop Windows application processes; release activation blocked'))
        else resolve(stdout)
      })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

const windowsAccess: ProcessAccess = {
  async list() {
    const output = await powershell(`$ErrorActionPreference = 'Stop'
      $rows = @(Get-CimInstance Win32_Process | ForEach-Object {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId
          created = $_.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfff')
          name = $_.Name; commandLine = $_.CommandLine }
      })
      ConvertTo-Json -InputObject $rows -Compress`)
    return JSON.parse(output.replace(/^\uFEFF/, ''))
  },
  async stop(processes) {
    await powershell(`$ErrorActionPreference = 'Stop'
      $targets = [Console]::In.ReadToEnd() | ConvertFrom-Json
      foreach ($target in $targets) {
        $current = Get-Process -Id $target.pid -ErrorAction SilentlyContinue
        if ($null -eq $current) { continue }
        try {
          # Hold the process handle and verify its start time, so a reused PID cannot be killed.
          $handle = $current.Handle
          if ($current.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfff') -eq $target.created) {
            $current.Kill()
          }
        } catch {
          if (-not $current.HasExited) { throw }
        } finally { $current.Dispose() }
      }`, JSON.stringify(processes.map(({ pid, created }) => ({ pid, created }))))
  },
}

const identity = (item: WindowsProcess) => `${item.pid}:${item.created}`

export async function listWindowsProcesses() { return windowsAccess.list() }

export function isProjectPhpServer(item: WindowsProcess, root: string) {
  if (!/^php(?:-cgi)?\.exe$/i.test(item.name) || !item.commandLine || !/(?:^|\s)-S\s*\S+/.test(item.commandLine)) return false
  const router = path.win32.resolve(root, 'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php').toLowerCase()
  // Require the complete router argument, not a root substring (which could match a different application).
  const argumentsWithPaths = item.commandLine.match(/"[^"]*"|[^\s"]+/g) || []
  return argumentsWithPaths.some(argument => path.win32.normalize(argument.replace(/^"|"$/g, '')).toLowerCase() === router)
}

export function ownedProjectProcesses(all: WindowsProcess[], seeds: WindowsProcess[], laravelRoot?: string) {
  const selected = new Map<string, WindowsProcess>()
  const seedIds = new Set(seeds.map(identity))
  for (const item of all) {
    if (seedIds.has(identity(item)) || (laravelRoot && isProjectPhpServer(item, laravelRoot))) selected.set(identity(item), item)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const item of all) {
      if (selected.has(identity(item))) continue
      const parent = [...selected.values()].find(parent => parent.pid === item.parentPid && parent.created <= item.created)
      if (parent) { selected.set(identity(item), item); changed = true }
    }
  }
  return [...selected.values()]
}

export async function captureProjectProcesses(root: string, pids: number[], laravel: boolean, access: ProcessAccess = windowsAccess): Promise<ProjectProcessSnapshot> {
  if (process.platform !== 'win32' && access === windowsAccess) return { processes: [] }
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)) throw new Error('Invalid application process identity')
  const all = await access.list()
  const laravelRoot = laravel ? root : undefined
  return { processes: ownedProjectProcesses(all, all.filter(item => pids.includes(item.pid)), laravelRoot), laravelRoot }
}

export async function stopProjectProcesses(snapshot: ProjectProcessSnapshot, append: (message: string) => void | Promise<void>, access: ProcessAccess = windowsAccess) {
  if (!snapshot.processes.length && !snapshot.laravelRoot) return
  const known = new Map(snapshot.processes.map(item => [identity(item), item]))
  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = ownedProjectProcesses(await access.list(), [...known.values()], snapshot.laravelRoot)
    if (!remaining.length) { await append('[process] Project process shutdown verified\n'); return }
    for (const item of remaining) known.set(identity(item), item)
    if (attempt === 3) throw new Error('Project processes still hold the release directory; activation blocked (PIDs: ' + remaining.map(item => item.pid).join(', ') + ')')
    await append('[process] Stopping surviving project processes: ' + remaining.map(item => item.pid).join(', ') + '\n')
    await access.stop(remaining)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
