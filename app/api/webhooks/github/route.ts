import { NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { query } from '@/lib/db'
import { startDeploy, type DeployProject } from '@/lib/deploy'

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  try {
    const event = request.headers.get('x-github-event')
    const signature = request.headers.get('x-hub-signature-256')
    const deliveryId = request.headers.get('x-github-delivery')

    // Only handle push events
    if (event !== 'push') {
      return NextResponse.json({ status: 'ignored', reason: `event type: ${event}` })
    }

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
    }

    const rawBody = await request.text()
    let payload: {
      ref?: string
      repository?: { full_name?: string; html_url?: string; clone_url?: string }
      head_commit?: { id?: string; message?: string }
    }
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const ref = payload.ref
    const repoFullName = payload.repository?.full_name
    const repoHtmlUrl = payload.repository?.html_url
    const repoCloneUrl = payload.repository?.clone_url

    if (!ref || !repoFullName) {
      return NextResponse.json({ error: 'Missing ref or repository' }, { status: 400 })
    }

    // Extract branch name from ref (e.g. refs/heads/dev → dev)
    const pushedBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null
    if (!pushedBranch) {
      return NextResponse.json({ status: 'ignored', reason: 'not a branch push' })
    }

    // Find ALL active projects matching this repo URL (staging + production)
    const { rows: allProjects } = await query<DeployProject & { webhook_secret: string | null }>(
      `SELECT id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pm2_name, port, webhook_secret
       FROM projects
       WHERE is_active = true AND (
         repo_url = $1 OR repo_url = $2 OR repo_url = $3 OR
         repo_url = $4 OR repo_url = $5 OR repo_url = $6
       )`,
      [
        `https://github.com/${repoFullName}`,
        `https://github.com/${repoFullName}.git`,
        repoHtmlUrl || '',
        repoCloneUrl || '',
        `git@github.com:${repoFullName}.git`,
        `git@github.com:${repoFullName}`,
      ]
    )

    if (allProjects.length === 0) {
      return NextResponse.json({ status: 'ignored', reason: 'no matching project' })
    }

    // Verify signature against any project's secret.
    // One GitHub webhook per repo can cover staging + production — they share the secret.
    const projectsWithSecrets = allProjects.filter(p => p.webhook_secret)
    if (projectsWithSecrets.length === 0) {
      return NextResponse.json({ error: 'No webhook secret configured' }, { status: 401 })
    }

    const signatureValid = projectsWithSecrets.some(p =>
      verifySignature(rawBody, signature, p.webhook_secret!)
    )

    if (!signatureValid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // Route to the project whose default_branch matches the pushed branch
    const targetProject = allProjects.find(p => (p.default_branch || 'main') === pushedBranch)

    if (!targetProject) {
      return NextResponse.json({
        status: 'ignored',
        reason: `no project configured for branch "${pushedBranch}"`,
      })
    }

    const commitSha = payload.head_commit?.id || 'unknown'
    const commitMsg = payload.head_commit?.message || ''

    // Start deploy async — creates DB record immediately, builds in background
    const deploymentId = await startDeploy(targetProject, { trigger: 'webhook' })

    if (!deploymentId) {
      return NextResponse.json({
        status: 'skipped',
        reason: 'deploy already running',
        project: targetProject.name,
      })
    }

    return NextResponse.json({
      status: 'deploying',
      project: targetProject.name,
      branch: pushedBranch,
      commit: commitSha.substring(0, 7),
      message: commitMsg.substring(0, 100),
      deliveryId,
      deploymentId,
    })
  } catch (error) {
    console.error('[webhook] Error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
