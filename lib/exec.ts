import { spawn, execSync } from 'child_process'

export interface CommandResult {
  code: number
  output: string
}

/** Kill a process tree on Windows using taskkill, falls back to SIGKILL */
/** Kill a process tree on Windows using taskkill, falls back to SIGKILL */
function killProcessTree(pid: number) {
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
  command: string,
  cwd?: string,
  timeoutMs = 300_000,
  onData?: (data: string) => void,
  env?: Record<string, string>
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        // Prevent git credential manager from opening GUI prompts in non-interactive PM2
        GIT_TERMINAL_PROMPT: '0',
        // Use GITHUB_TOKEN via deploy.ts withGithubToken() instead of credential manager
        GCM_INTERACTIVE: 'never',
        // Completely disable askpass helpers (prevents Windows GCM from prompting)
        GIT_ASKPASS: 'echo',
        // Disable Windows Credential Manager integration
        GCM_PROVIDER: 'generic',
      },
    })

    let output = ''
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      if (child.pid) killProcessTree(child.pid)
      const msg = `\n[timeout] Command killed after ${timeoutMs / 1000}s\n`
      output += msg
      if (onData) onData(msg)
      resolve({ code: 1, output })
    }, timeoutMs)

    child.stdout.on('data', (data) => {
      const str = data.toString()
      output += str
      if (onData) onData(str)
    })

    child.stderr.on('data', (data) => {
      const str = data.toString()
      output += str
      if (onData) onData(str)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      if (!killed) {
        const msg = `\n[error] ${error.message}\n`
        output += msg
        if (onData) onData(msg)
        resolve({ code: 1, output })
      }
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (!killed) {
        resolve({ code: code ?? 0, output })
      }
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
