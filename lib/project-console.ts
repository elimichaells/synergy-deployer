import { parse } from 'dotenv'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export function validateConsoleCommand(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Enter a command'
  if (value.length > 8000) return 'Command must be at most 8,000 characters'
  // The console intentionally exposes the host shell to operators. Keep each
  // request on one command line so streaming, cancellation and audit admission
  // remain bounded; shell composition on that line is supported.
  if (/[\r\n\x00]/.test(value)) return 'Run one command line at a time'
  return null
}

export function prepareConsoleCommand(command: string) {
  const first = command.trim().split(/\s+/)[0]
  const usesPowerShell = /^[A-Z][a-zA-Z]+-[A-Z][a-zA-Z]+$/.test(first)
    || /\$(?:env:|[A-Za-z_])|@\{|\|\s*(?:Where|Select|ForEach|Sort|Group|Measure|Format)-/i.test(command)
    || /^(?:ls|cat)\b/i.test(command.trim())
  if (!usesPowerShell) return command
  const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ${command}`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand ${encoded}`
}

export function projectQuickCommands(type: string) {
  if (type === 'go') return ['go version', 'go mod download', 'go test ./...', 'go list ./...']
  if (type === 'laravel') return ['php --version', 'composer install --no-interaction', 'php artisan about', 'php artisan migrate:status', 'php artisan schedule:list']
  return ['node --version', 'npm ci --include=dev', 'npm run build', 'npm outdated']
}

export async function resolveConsoleWorkingDirectory(root: string, requested?: unknown) {
  const projectRoot = await realpath(root)
  const raw = typeof requested === 'string' && requested.trim() ? requested.trim() : projectRoot
  const target = await realpath(path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw)).catch(() => { throw new Error('Directory does not exist') })
  const rootKey = projectRoot.toLowerCase()
  const targetKey = target.toLowerCase()
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep.toLowerCase())) throw new Error('Console directory must stay inside the application root')
  return target
}

export async function readProjectEnvironment(root: string, type: string) {
  const env: Record<string, string> = {}
  for (const file of type === 'laravel' ? ['.env'] : ['.env', '.env.local']) {
    try { Object.assign(env, parse(await readFile(path.join(root, file)))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return env
}
