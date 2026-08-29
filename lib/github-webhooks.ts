import { randomBytes } from 'crypto'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { getGitHubConnectionToken } from '@/lib/github-connections'

export const GITHUB_WEBHOOK_URL = 'https://deploy.smartcloudgh.com/api/webhooks/github'

interface ProjectWebhookRecord {
  id: string
  repo_url: string | null
  webhook_secret: string | null
  github_connection_id: string | null
}

interface GitHubHook {
  id: number
  active: boolean
  config: { url?: string; content_type?: string; insecure_ssl?: string }
  events: string[]
}

export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.trim().match(/github\.com[/:]([\w.\-]+)\/([\w.\-]+?)(?:\.git)?\/?$/i)
  return match ? { owner: match[1], repo: match[2] } : null
}

function sameRepo(left: string | null, right: { owner: string; repo: string }) {
  if (!left) return false
  const parsed = parseGitHubRepo(left)
  return !!parsed && parsed.owner.toLowerCase() === right.owner.toLowerCase() && parsed.repo.toLowerCase() === right.repo.toLowerCase()
}

async function githubFetch(token: string, path: string, options: RequestInit = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
}

async function projectAndToken(projectId: string) {
  const { rows } = await query<ProjectWebhookRecord>(
    'select id, repo_url, webhook_secret, github_connection_id from projects where id = $1',
    [projectId]
  )
  const project = rows[0]
  if (!project) throw new ApiError('Project not found', 404)
  if (!project.repo_url) throw new ApiError('Configure a GitHub repository before enabling auto deploy', 400)

  const repository = parseGitHubRepo(project.repo_url)
  if (!repository) throw new ApiError('Auto deploy currently requires a GitHub repository URL', 400)

  const token = await getGitHubConnectionToken(project.github_connection_id)
  if (!token) throw new ApiError('Assign a GitHub connection before enabling auto deploy', 400)

  return { project, repository, token }
}

async function relatedProjects(repository: { owner: string; repo: string }) {
  const { rows } = await query<ProjectWebhookRecord>(
    'select id, repo_url, webhook_secret, github_connection_id from projects where is_active = true and repo_url is not null'
  )
  return rows.filter((project) => sameRepo(project.repo_url, repository))
}

async function listHooks(token: string, repository: { owner: string; repo: string }) {
  const response = await githubFetch(token, `/repos/${repository.owner}/${repository.repo}/hooks`)
  if (response.status === 404) {
    throw new ApiError(`GitHub repository ${repository.owner}/${repository.repo} was not found, or the token does not include it with Webhooks read/write permission`, 409)
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError('The GitHub token needs Webhooks read/write permission for this repository to configure auto deploy', 409)
  }
  if (!response.ok) throw new ApiError(`GitHub webhook check failed with HTTP ${response.status}`, 502)
  return (await response.json()) as GitHubHook[]
}

export async function getGitHubWebhookStatus(projectId: string) {
  const { project, repository, token } = await projectAndToken(projectId)
  if (!project.webhook_secret) return { installed: false, reason: 'no_secret' as const }
  const hooks = await listHooks(token, repository)
  const hook = hooks.find((item) => item.config?.url === GITHUB_WEBHOOK_URL)
  return {
    installed: !!hook,
    hookId: hook?.id ?? null,
    active: hook?.active ?? null,
    events: hook?.events ?? null,
  }
}

export async function ensureGitHubWebhook(projectId: string) {
  const { project, repository, token } = await projectAndToken(projectId)
  const siblings = await relatedProjects(repository)
  const secret = project.webhook_secret || siblings.find((item) => item.webhook_secret)?.webhook_secret || randomBytes(32).toString('hex')
  const hooks = await listHooks(token, repository)
  const existing = hooks.find((item) => item.config?.url === GITHUB_WEBHOOK_URL)
  const hookConfig = {
    url: GITHUB_WEBHOOK_URL,
    content_type: 'json',
    secret,
    insecure_ssl: '0',
  }

  const response = existing
    ? await githubFetch(token, `/repos/${repository.owner}/${repository.repo}/hooks/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: true, events: ['push'], config: hookConfig }),
      })
    : await githubFetch(token, `/repos/${repository.owner}/${repository.repo}/hooks`, {
        method: 'POST',
        body: JSON.stringify({ name: 'web', active: true, events: ['push'], config: hookConfig }),
      })

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string }
    throw new ApiError(`GitHub rejected webhook ${existing ? 'update' : 'creation'}: ${body.message || response.status}`, 502)
  }

  const hook = (await response.json()) as { id: number }
  const projectIds = siblings.map((item) => item.id)
  if (!projectIds.includes(project.id)) projectIds.push(project.id)
  await query(
    'update projects set webhook_secret = $1, updated_at = now() where id = any($2::uuid[])',
    [secret, projectIds]
  )

  return {
    installed: true,
    hookId: hook.id,
    action: existing ? 'updated' as const : 'created' as const,
    repository: `${repository.owner}/${repository.repo}`,
    projectIds,
  }
}

export async function removeGitHubWebhook(projectId: string) {
  const { repository, token } = await projectAndToken(projectId)
  const hooks = await listHooks(token, repository)
  const hook = hooks.find((item) => item.config?.url === GITHUB_WEBHOOK_URL)
  if (!hook) return { status: 'not_found' as const }

  const response = await githubFetch(token, `/repos/${repository.owner}/${repository.repo}/hooks/${hook.id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new ApiError(`GitHub webhook removal failed with HTTP ${response.status}`, 502)
  return { status: 'removed' as const, hookId: hook.id }
}
