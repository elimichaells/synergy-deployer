import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { getGitConnection, getGitHubConnectionToken } from './github-connections'
import { gitApi } from './git-provider-api'
import { repositoryPath, repositoryUrl, type GitProvider } from './git-provider-policy'
import { managerUrl } from './manager-address'
import * as github from './github-webhooks'

export function gitWebhookUrl(provider: GitProvider) { return `${managerUrl()}/api/webhooks/${provider}` }
async function context(id: string) {
  const { rows } = await query<{ id: string; repo_url: string; github_connection_id: string | null; webhook_secret: string | null }>(
    'select id,repo_url,github_connection_id,webhook_secret from projects where id=$1', [id])
  const project = rows[0]
  if (!project) throw new ApiError('Application not found', 404)
  const host = await getGitConnection(project.github_connection_id)
  const repository = repositoryPath(project.repo_url, host)
  return { project, host, repository }
}
async function hookContext(id: string) {
  const ctx = await context(id)
  const token = await getGitHubConnectionToken(ctx.project.github_connection_id)
  if (!token) throw new ApiError('Assign a Git connection before configuring auto deploy', 400)
  const endpoint = ctx.host.provider === 'gitlab' ? `/projects/${encodeURIComponent(ctx.repository)}/hooks` : `/repos/${ctx.repository}/hooks`
  const hooks: any[] = []
  for (let page = 1; page <= 20; page++) {
    const response = await gitApi(ctx.host, token, endpoint + `?page=${page}&per_page=100&limit=100`)
    if (!response.ok || !Array.isArray(response.data)) throw new ApiError(`Cannot read ${ctx.host.provider} webhooks (HTTP ${response.status}). The token needs repository webhook administration access.`, 409)
    hooks.push(...response.data)
    if (response.data.length < 100) break
    if (page === 20) throw new ApiError('Too many repository webhooks to inspect safely', 409)
  }
  const existing = hooks.find(hook => (hook.url || hook.config?.url) === gitWebhookUrl(ctx.host.provider))
  return { ...ctx, token, endpoint, existing }
}

export async function getGitWebhookStatus(id: string) {
  const { host } = await context(id)
  if (host.provider === 'github') return { ...await github.getGitHubWebhookStatus(id), webhookUrl: gitWebhookUrl('github') }
  const { project, existing } = await hookContext(id)
  return { installed: !!existing && !!project.webhook_secret, hookId: existing?.id || null,
    active: existing?.active ?? existing?.push_events ?? false, webhookUrl: gitWebhookUrl(host.provider) }
}

export async function ensureGitWebhook(id: string) {
  const { host } = await context(id)
  if (host.provider === 'github') return github.ensureGitHubWebhook(id)
  const ctx = await hookContext(id)
  const { rows: candidates } = await query<{ id: string; repo_url: string; webhook_secret: string | null }>('select id,repo_url,webhook_secret from projects where is_active=true and repo_url is not null')
  const siblings = candidates.filter(row => { try { return repositoryUrl(row.repo_url) === repositoryUrl(ctx.project.repo_url) } catch { return false } })
  const secret = ctx.project.webhook_secret || siblings.find(row => row.webhook_secret)?.webhook_secret || randomBytes(32).toString('hex')
  const body = host.provider === 'gitlab'
    ? { url: gitWebhookUrl(host.provider), token: secret, push_events: true, tag_push_events: false, enable_ssl_verification: true }
    : { type: 'gitea', active: true, events: ['push'], config: { url: gitWebhookUrl(host.provider), content_type: 'json', secret } }
  const response = await gitApi(host, ctx.token, ctx.endpoint + (ctx.existing ? `/${ctx.existing.id}` : ''), {
    method: ctx.existing ? (host.provider === 'gitlab' ? 'PUT' : 'PATCH') : 'POST', body,
  })
  if (!response.ok) throw new ApiError(`${host.provider} rejected webhook configuration (HTTP ${response.status}). Check token permissions and server webhook network rules.`, 502)
  const projectIds = [...new Set([id, ...siblings.map(row => row.id)])]
  await query('update projects set webhook_secret=$1,updated_at=now() where id=any($2::uuid[])', [secret, projectIds])
  return { installed: true, hookId: response.data.id, action: ctx.existing ? 'updated' as const : 'created' as const, repository: ctx.repository, projectIds }
}

export async function removeGitWebhook(id: string) {
  const { host } = await context(id)
  if (host.provider === 'github') return github.removeGitHubWebhook(id)
  const ctx = await hookContext(id)
  if (!ctx.existing) return { status: 'not_found' as const }
  const response = await gitApi(host, ctx.token, `${ctx.endpoint}/${ctx.existing.id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) throw new ApiError('Could not remove Git webhook', 502)
  return { status: 'removed' as const, hookId: ctx.existing.id }
}

export function verifyGitWebhook(provider: 'gitlab' | 'gitea', body: string, headers: Headers, secret: string) {
  if (!secret) return false
  const supplied = headers.get(provider === 'gitlab' ? 'x-gitlab-token' : 'x-gitea-signature') || ''
  const expected = provider === 'gitlab' ? secret : createHmac('sha256', secret).update(body).digest('hex')
  return Buffer.byteLength(supplied) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

export function gitPush(provider: 'gitlab' | 'gitea', payload: any) {
  const repo = provider === 'gitlab' ? payload.project?.git_http_url : payload.repository?.clone_url
  const ref = payload.ref
  const sha = payload.after
  if (typeof repo !== 'string' || typeof ref !== 'string' || !ref.startsWith('refs/heads/') || typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha) || /^0+$/.test(sha) || payload.deleted === true) return null
  return { repository: repositoryUrl(repo), branch: ref.slice(11), sha }
}
