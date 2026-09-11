import { existsSync } from 'node:fs'
import path from 'node:path'
import { ApiError } from '@/lib/api'
import { getGitHubConnectionToken } from '@/lib/github-connections'

// Only standalone network commands receive credentials. Shell commands such as
// `set`, scripts and `git config` continue to run without the saved token.
export function consoleGitArguments(command: string): string[] | null {
  if (!/^git(?:\.exe)?\s+(?:fetch|pull|push|ls-remote)(?:\s|$)/i.test(command.trim())) return null
  if (/[&|<>;`$%\r\n\x00]/.test(command)) throw new ApiError('Run Git network commands separately, without shell operators or variable expansion, to use the saved GitHub connection.', 400)
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
    throw new ApiError('Custom Git transport executables cannot use the saved GitHub connection.', 400)
  }
  return args
}

export function githubRepositoryUrls(value?: string | null): string[] {
  try {
    const url = new URL(value || '')
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.search || url.hash) return []
    const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)\/?$/)
    if (!match) return []
    const repo = `https://github.com/${match[1]}/${match[2].replace(/\.git$/, '')}`
    return [repo, `${repo}.git`]
  } catch { return [] }
}

export function consoleGitEnvironment(urls: string[], token: string) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  const config: [string, string][] = [
    ['credential.helper', ''],
    ['http.extraHeader', ''],
    ['http.followRedirects', 'false'],
  ]
  for (const url of urls) {
    config.push([`http.${url}.extraHeader`, ''], [`http.${url}.extraHeader`, `Authorization: Basic ${basic}`])
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(config.length) }
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value })
  return { env, secrets: [token, basic] }
}

function installedGit(projectRoot: string) {
  // Do not resolve a project-local git.exe or use the application's PATH while
  // supplying a Manager credential.
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  const directories = [
    ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd')] : []),
    ...(process.env.Path || process.env.PATH || '').split(path.delimiter),
  ]
  const root = path.resolve(projectRoot).toLowerCase()
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    const file = path.resolve(directory, executable)
    if (file.toLowerCase().startsWith(root + path.sep) || !existsSync(file)) continue
    return file
  }
  throw new ApiError('Git is not installed on the Manager server. Install Git from Runtimes and retry.', 409)
}

export async function prepareConsoleGit(command: string, app: { root_path: string; repo_url?: string | null; github_connection_id?: string | null }) {
  const urls = githubRepositoryUrls(app.repo_url)
  if (!urls.length) return null
  const args = consoleGitArguments(command)
  if (!args) return null
  const token = await getGitHubConnectionToken(app.github_connection_id)
  return {
    command: { file: installedGit(app.root_path), args },
    ...(token ? consoleGitEnvironment(urls, token) : { env: {}, secrets: [] }),
    authenticated: Boolean(token),
  }
}

export function consoleGitFailureHint(output: string) {
  if (!/Authentication failed|Invalid username or token|could not read Username|could not read Password|Repository not found|Permission .* denied/i.test(output)) return ''
  return '\n[auth] Check the GitHub connection selected in this application’s Setup. Test or update it in Settings > Connections > GitHub accounts and ensure it can access this repository (write access is required for push). Then retry the command.\n'
}
