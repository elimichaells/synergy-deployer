import { spawn, execSync } from 'child_process'

export interface CommandResult {
  code: number
  output: string
}

interface CommandControl {
  signal?: AbortSignal
  heartbeatMs?: number
  redact?: string[]
}

export type Command = string | { file: string; args: string[] }

/** Retain partial secrets across chunks so neither output nor the stream leaks them. */
export function secretRedactor(secrets: string[], write: (text: string) => void) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  let pending = ''
  return {
    write(text: string) {
      if (!values.length) { write(text); return }
      pending += text
      let safe = ''
      while (pending) {
        const match = values.find(value => pending.startsWith(value))
        if (match) { safe += '[redacted]'; pending = pending.slice(match.length) }
        else if (values.some(value => value.startsWith(pending))) break
        else { safe += pending[0]; pending = pending.slice(1) }
      }
      if (safe) write(safe)
    },
    end() {
      // A truncated credential is still sensitive.
      if (pending) write('[redacted]')
      pending = ''
    },
  }
}

/** Kill a process tree on Windows using taskkill, falls back to SIGKILL */
export function killProcessTree(pid: number) {
  try {
    execSync(`taskkill /T /F /PID ${pid}`, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
  } catch {
    // Fallback — taskkill may fail if process already exited
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already dead
    }
  }
}

export function runCommand(
  command: Command,
  cwd?: string,
  timeoutMs = 300_000,
  onData?: (data: string) => void,
  env?: Record<string, string>,
  inheritProcessEnv = true,
  control: CommandControl = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (control.signal?.aborted) {
      const output = '[cancelled] Command was not started\n'
      onData?.(output)
      resolve({ code: 1, output })
      return
    }
    const pathEntries = [
      'C:\\Program Files\\Go\\bin',
      'C:\\Program Files\\PostgreSQL\\18\\bin',
      'C:\\ProgramData\\chocolatey\\bin',
      'C:\\tools\\mysql\\current\\bin',
      process.env.APPDATA ? `${process.env.APPDATA}\\npm` : '',
    ].filter(Boolean)
    const requestedPath = env?.Path || env?.PATH || ''
    const managedPath = [requestedPath, ...pathEntries, process.env.Path || process.env.PATH || ''].filter(Boolean).join(';')
    const systemEnv: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV || 'production' }
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PM2_HOME']) {
      if (process.env[key]) systemEnv[key] = process.env[key]
    }
    const child = spawn(typeof command === 'string' ? command : command.file, typeof command === 'string' ? [] : command.args, {
      cwd,
      shell: typeof command === 'string',
      windowsHide: true,
      env: {
        ...(inheritProcessEnv ? process.env : systemEnv),
        ...env,
        Path: managedPath,
        PATH: managedPath,
        // Prevent git credential manager from opening GUI prompts in non-interactive PM2
        GIT_TERMINAL_PROMPT: '0',
        // Authentication must be supplied by the caller; a server cannot prompt.
        GCM_INTERACTIVE: 'never',
        // Completely disable askpass helpers (prevents Windows GCM from prompting)
        GIT_ASKPASS: 'echo',
        // Disable Windows Credential Manager integration
        GCM_PROVIDER: 'generic',
      },
    })

    let output = ''
    let settled = false
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    const emit = (message: string) => {
      if (settled) return
      lastOutputAt = Date.now()
      output += message
      onData?.(message)
    }
    const stdout = secretRedactor(control.redact || [], emit)
    const stderr = secretRedactor(control.redact || [], emit)
    const finish = (code: number) => {
      if (settled) return
      stdout.end()
      stderr.end()
      settled = true
      clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      control.signal?.removeEventListener('abort', cancel)
      resolve({ code, output })
    }
    const stop = (message: string) => {
      if (settled) return
      if (child.pid) killProcessTree(child.pid)
      emit(message)
      finish(1)
    }
    const cancel = () => stop('\n[cancelled] Command process tree stopped\n')
    const timer = setTimeout(() => stop(`\n[timeout] Command killed after ${timeoutMs / 1000}s\n`), timeoutMs)
    const heartbeat = control.heartbeatMs ? setInterval(() => {
      if (Date.now() - lastOutputAt >= control.heartbeatMs!) {
        emit(`[progress] Command is still running (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed; limit ${timeoutMs / 1000}s)\n`)
      }
    }, control.heartbeatMs) : undefined
    control.signal?.addEventListener('abort', cancel, { once: true })
    if (control.signal?.aborted) cancel()

    child.stdout.on('data', (data) => {
      stdout.write(data.toString())
    })

    child.stderr.on('data', (data) => {
      stderr.write(data.toString())
    })

    child.on('error', (error) => {
      stderr.write(`\n[error] ${error.message}\n`)
      finish(1)
    })

    child.on('close', (code) => {
      finish(code ?? 1)
    })
  })
}

/**
 * Run a command with retry logic for transient failures
 * Useful for network operations like git fetch
 */
export async function runCommandWithRetry(
  command: string,
  cwd?: string,
  timeoutMs = 300_000,
  maxRetries = 2,
  onData?: (data: string) => void,
  env?: Record<string, string>
): Promise<CommandResult> {
  let lastError: CommandResult | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runCommand(command, cwd, timeoutMs, onData, env)

    if (result.code === 0) return result

    // Don't retry on authentication errors
    if (
      result.output.includes('Authentication failed') ||
      result.output.includes('Permission denied') ||
      result.output.includes('fatal: could not read')
    ) {
      return result
    }

    lastError = result

    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000 // 1s, 2s
      const msg = `\n[retry] Attempt ${attempt + 1} failed, retrying in ${delay / 1000}s...\n`
      if (onData) onData(msg)
      lastError.output += msg
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return lastError!
}
