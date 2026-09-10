export function managedStartCommand(command: string, projectType: string, port: number | null) {
  if (projectType !== 'laravel' || !/\bartisan["']?\s+serve\b/i.test(command)) return command
  if (/[&|<>\r\n]/.test(command) || !/^(?:php(?:\.exe)?|"[^"\r\n]*[\\/]php(?:\.exe)?"|[^\s"]*[\\/]php(?:\.exe)?)\s+["']?artisan["']?\s+serve\b/i.test(command.trim())) {
    throw new Error('Configure Laravel serve as a single php artisan serve command; use deployment hooks for other commands')
  }
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid assigned application port')
  // Replace options instead of appending duplicates. Artisan must never retry on another application's port.
  const normalized = command.trim()
    .replace(/\s+--(?:port|tries)(?:=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)|\s+(?!-)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+))/g, '')
    .replace(/\s+--no-reload(?=\s|$)/g, '')
  if (/\s+--(?:port|tries|no-reload)\b/.test(normalized)) throw new Error('Invalid Laravel serve port, tries or reload option')
  return `${normalized}${port ? ` --port=${port}` : ''} --no-reload --tries=1`
}

export function managedRuntimeEnvironment(projectType: string, platform: string = process.platform): Record<string, string> {
  // PHP's CLI server does not support multiple workers on Windows, even with --no-reload.
  return projectType === 'laravel' && platform === 'win32' ? { PHP_CLI_SERVER_WORKERS: '1' } : {}
}
