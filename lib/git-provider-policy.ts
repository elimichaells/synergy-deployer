export type GitProvider = 'github' | 'gitlab' | 'gitea'
export interface GitHost { provider: GitProvider; base_url: string; ca_pem?: string | null }

export function gitHost(provider: unknown = 'github', baseUrl: unknown = 'https://github.com'): GitHost {
  if (!['github', 'gitlab', 'gitea'].includes(String(provider))) throw new Error('Choose GitHub, GitLab or Gitea')
  const raw = String(baseUrl).replace(/\/+$/, '')
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^https:\/\/[\w.[\]:-]+(?:\/[\w.-]+)*$/i.test(raw)
    || raw.split('/').some(part => part === '.' || part === '..')) throw new Error('Use an HTTPS Git server address without credentials, query parameters or fragments')
  if (provider === 'github' && url.href !== 'https://github.com/') throw new Error('GitHub connections use https://github.com')
  return { provider: provider as GitProvider, base_url: url.href.replace(/\/$/, '') }
}

export function repositoryUrl(value: string) {
  // Strict syntax also keeps repository addresses safe in existing shell-based deployment commands.
  if (!/^https:\/\/[\w.[\]:-]+(?:\/[\w.-]+){2,}\/?$/i.test(value) || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Use an HTTPS repository URL without credentials, query parameters or shell characters')
  }
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Git repository URL')
  return url.href.replace(/\/$/, '').replace(/\.git$/, '')
}

export function repositoryPath(value: string, host: GitHost) {
  const repo = repositoryUrl(value)
  const prefix = host.base_url + '/'
  if (!repo.startsWith(prefix)) throw new Error('Repository address does not belong to the selected Git connection')
  const relative = repo.slice(prefix.length)
  const segments = relative.split('/')
  if (segments.length < 2 || (host.provider !== 'gitlab' && segments.length !== 2)) throw new Error('Invalid repository path for the selected Git provider')
  return relative
}
