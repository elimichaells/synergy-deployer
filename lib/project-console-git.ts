import { ApiError } from '@/lib/api'
import { prepareGitAccess, gitEnvironment, installedGit } from '@/lib/git-access'

// Only standalone network commands receive credentials. Shell commands such as
// `set`, scripts and `git config` continue to run without the saved token.
export function consoleGitArguments(command: string): string[] | null {
  if (!/^git(?:\.exe)?\s+(?:fetch|pull|push|ls-remote)(?:\s|$)/i.test(command.trim())) return null
  if (/[&|<>;`$%\r\n\x00]/.test(command)) throw new ApiError('Run Git network commands separately, without shell operators or variable expansion, to use the saved Git connection.', 400)
  const parts: string[] = []
  let current = '', quote = '', started = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/.test(char)) {
      if (started) { parts.push(current); current = ''; started = false }
    } else { current += char; started = true }
  }
  if (quote) throw new ApiError('Close the quote in the Git command.', 400)
  if (started) parts.push(current)
  const args = parts.slice(1)
  // These options execute a caller-selected helper with the credential environment.
  if (args.slice(1).some(arg => (arg.startsWith('--') && arg !== '--' && ['--upload-pack', '--receive-pack', '--exec'].some(option => option.startsWith(arg.split('=')[0])))
    || (args[0] === 'ls-remote' && /^-u/.test(arg)) || (args[0] === 'push' && /^-e/.test(arg)))) {
    throw new ApiError('Custom Git transport executables cannot use the saved Git connection.', 400)
  }
  return args
}

export async function prepareConsoleGit(command: string, app: { root_path: string; repo_url?: string | null; github_connection_id?: string | null }) {
  if (!app.repo_url?.startsWith('https://')) return null
  const args = consoleGitArguments(command)
  if (!args) return null
  const access = await prepareGitAccess(app)
  return { command: { file: installedGit(app.root_path), args }, env: gitEnvironment(access.config, app.root_path), secrets: access.secrets, authenticated: access.authenticated }

}

export function consoleGitFailureHint(output: string) {
  if (!/Authentication failed|Invalid username or token|could not read Username|could not read Password|Repository not found|Permission .* denied/i.test(output)) return ''
  return '\n[auth] Check the Git connection selected in this application’s Setup. Test or update it in Settings > Connections > Git connections and ensure it can access this repository (write access is required for push). Then retry the command.\n'
}
