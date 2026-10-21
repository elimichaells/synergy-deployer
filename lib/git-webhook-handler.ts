import { query } from '@/lib/db'
import { startDeploy, type DeployProject } from '@/lib/deploy'
import { repositoryUrl } from './git-provider-policy'
import { gitPush, verifyGitWebhook } from './git-webhooks'

export async function receiveGitPush(request: Request, provider: 'gitlab' | 'gitea') {
  const event = request.headers.get(provider === 'gitlab' ? 'x-gitlab-event' : 'x-gitea-event')
  if (event !== (provider === 'gitlab' ? 'Push Hook' : 'push')) return Response.json({ status: 'ignored' })
  // Bound unauthenticated bodies before parsing or querying the control database.
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
  if (!reader) return Response.json({ error: 'Missing body' }, { status: 400 })
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > 2 * 1024 * 1024) { await reader.cancel(); return Response.json({ error: 'Payload too large' }, { status: 413 }) }
    chunks.push(value)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let push: ReturnType<typeof gitPush>
  try { push = gitPush(provider, JSON.parse(raw)) } catch { return Response.json({ error: 'Invalid push payload' }, { status: 400 }) }
  if (!push) return Response.json({ status: 'ignored', reason: 'not a branch update' })
  try {
    const { rows } = await query<DeployProject & { webhook_secret: string | null; live_commit: string | null }>(
      `select p.*,d.commit_sha as live_commit from projects p join github_connections c on c.id=p.github_connection_id
       left join deployments d on d.id=p.active_deployment_id where p.is_active=true and p.auto_deploy=true and c.provider=$1 and p.default_branch=$2`, [provider, push.branch])
    const matching = rows.filter(project => { try { return repositoryUrl(project.repo_url) === push!.repository } catch { return false } })
    const authorized = matching.filter(project => verifyGitWebhook(provider, raw, request.headers, project.webhook_secret || ''))
    if (!authorized.length) return Response.json({ error: 'No authorized application for this push' }, { status: 401 })
    const deployments = []
    for (const project of authorized) {
      if (project.live_commit === push.sha) continue
      const deploymentId = await startDeploy(project, { trigger: 'webhook' })
      if (deploymentId) deployments.push({ project: project.name, deploymentId })
    }
    return Response.json({ status: deployments.length ? 'deploying' : 'skipped', deployments })
  } catch { return Response.json({ error: 'Could not process Git webhook' }, { status: 500 }) }
}
