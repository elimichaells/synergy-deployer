import { existsSync } from 'node:fs'
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { rootCertificates } from 'node:tls'
import path from 'node:path'
import { getGitConnection, getGitHubConnectionToken } from './github-connections'
import { repositoryPath, repositoryUrl } from './git-provider-policy'
import { managerDataRoot, toolPathEntries } from './paths'

export function installedGit(projectRoot: string) {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  const directories = [...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd')] : []),
    ...toolPathEntries(), ...(process.env.Path || process.env.PATH || '').split(path.delimiter)]
  const root = path.resolve(projectRoot).toLowerCase()
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    const file = path.resolve(directory, executable)
    if (!file.toLowerCase().startsWith(root + path.sep) && existsSync(file)) return file
  }
  throw new Error('Git is not installed on the server. Install Git from Runtimes and retry.')
}

export function gitEnvironment(config: [string, string][], cwd?: string) {
  const entries: [string, string][] = [
    ['credential.helper', ''], ['http.extraHeader', ''], ['http.followRedirects', 'false'],
    ['http.sslVerify', 'true'], ['protocol.allow', 'never'], ['protocol.https.allow', 'always'],
    ['user.name', 'Synergy Deployer'], ['user.email', 'deployer@localhost'],
    ['core.hooksPath', path.join(managerDataRoot(), 'disabled-git-hooks').replace(/\\/g, '/')],
    ...(cwd ? [['safe.directory', path.resolve(cwd).replace(/\\/g, '/')] as [string, string]] : []), ...config,
  ]
  // No user profile configuration or credential cache is needed after SYSTEM restores PM2.
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: String(entries.length) }
  entries.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value })
  return env
}

export async function prepareGitAccess(project: { repo_url?: string | null; github_connection_id?: string | null }) {
  const repo = repositoryUrl(project.repo_url || '')
  const host = await getGitConnection(project.github_connection_id)
  repositoryPath(repo, host)
  const token = await getGitHubConnectionToken(project.github_connection_id)
  const config: [string, string][] = []
  const secrets: string[] = []
  if (token) {
    const username = host.provider === 'github' ? 'x-access-token' : host.account_login
    const basic = Buffer.from(`${username}:${token}`).toString('base64')
    secrets.push(token, basic)
    for (const url of [repo, repo + '.git']) config.push([`http.${url}.extraHeader`, ''], [`http.${url}.extraHeader`, `Authorization: Basic ${basic}`])
  }
  if (host.ca_pem) {
    // Only public certificates go on disk. Content names keep rotation atomic for active commands.
    const directory = path.join(managerDataRoot(), 'git-ca')
    await mkdir(directory, { recursive: true })
    const filename = path.join(directory, createHash('sha256').update(host.ca_pem).digest('hex') + '.pem')
    if (!existsSync(filename)) {
      const temporary = path.join(directory, randomUUID() + '.tmp')
      try {
        await writeFile(temporary, [...rootCertificates, host.ca_pem].join('\n'), { flag: 'wx' })
        await rename(temporary, filename).catch(error => { if (!existsSync(filename)) throw error })
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    }
    for (const url of [repo, repo + '.git']) config.push([`http.${url}.sslCAInfo`, filename.replace(/\\/g, '/')], [`http.${url}.sslBackend`, 'openssl'])
  }
  return { config, secrets, authenticated: !!token, provider: host.provider }
}

/** Split generated Git commands into argv; never invoke a shell with Git credentials. */
export function gitCommand(command: string, projectRoot: string) {
  const args: string[] = []; let value = '', quote = '', started = false
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = ''; else value += char }
    else if (char === '"' || char === "'") { quote = char; started = true }
    else if (/\s/.test(char)) { if (started) { args.push(value); value = ''; started = false } }
    else { value += char; started = true }
  }
  if (quote) throw new Error('Invalid Git command quoting')
  if (started) args.push(value)
  if (!/^git(?:\.exe)?$/i.test(args.shift() || '')) throw new Error('Expected a Git command')
  return { file: installedGit(projectRoot), args }
}
