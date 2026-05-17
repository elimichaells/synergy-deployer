import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getSetting } from '@/lib/settings'

const WEBHOOK_URL = 'https://deploy.smartcloudgh.com/api/webhooks/github'

function parseRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = repoUrl.match(/github\.com[/:]([\w.\-]+)\/([\w.\-]+?)(?:\.git)?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

async function ghFetch(token: string, path: string, options: RequestInit = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
  })
}

interface GhHook {
  id: number
  active: boolean
  config: { url: string; content_type: string; insecure_ssl: string }
  events: string[]
}

async function findExistingHook(token: string, owner: string, repo: string): Promise<GhHook | null> {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/hooks`)
  if (!res.ok) return null
  const hooks = (await res.json()) as GhHook[]
  return hooks.find((h) => h.config?.url === WEBHOOK_URL) ?? null
}

// GET — check if the webhook is installed on GitHub
export async function GET(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const { rows } = await query<{ repo_url: string | null; webhook_secret: string | null }>(
      'SELECT repo_url, webhook_secret FROM projects WHERE id = $1',
      [context.params.id]
    )
    if (rows.length === 0) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const { repo_url, webhook_secret } = rows[0]
    if (!repo_url) return NextResponse.json({ installed: false, reason: 'no_repo_url' })
    if (!webhook_secret) return NextResponse.json({ installed: false, reason: 'no_secret' })

    const parsed = parseRepo(repo_url)
    if (!parsed) return NextResponse.json({ installed: false, reason: 'invalid_repo_url' })

    const token = await getSetting('GITHUB_TOKEN')
    if (!token) return NextResponse.json({ installed: false, reason: 'no_github_token' })

    const listRes = await ghFetch(token, `/repos/${parsed.owner}/${parsed.repo}/hooks`)
    if (listRes.status === 404) return NextResponse.json({ installed: false, reason: 'repo_not_found' })
    if (listRes.status === 401 || listRes.status === 403) {
      return NextResponse.json({ installed: false, reason: 'token_insufficient' })
    }
    if (!listRes.ok) return NextResponse.json({ installed: false, reason: `github_${listRes.status}` })

    const hooks = (await listRes.json()) as GhHook[]
    const hook = hooks.find((h) => h.config?.url === WEBHOOK_URL)

    return NextResponse.json({
      installed: !!hook,
      hookId: hook?.id ?? null,
      active: hook?.active ?? null,
      events: hook?.events ?? null,
    })
  } catch (error) {
    return jsonError(error)
  }
}

// POST — install or update the webhook on GitHub
export async function POST(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const { rows } = await query<{ repo_url: string | null; webhook_secret: string | null }>(
      'SELECT repo_url, webhook_secret FROM projects WHERE id = $1',
      [context.params.id]
    )
    if (rows.length === 0) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const { repo_url, webhook_secret } = rows[0]
    if (!repo_url) return NextResponse.json({ error: 'No repo URL configured on this project' }, { status: 400 })
    if (!webhook_secret) return NextResponse.json({ error: 'Generate a webhook secret first' }, { status: 400 })

    const parsed = parseRepo(repo_url)
    if (!parsed) return NextResponse.json({ error: 'Cannot parse GitHub repo URL' }, { status: 400 })

    const token = await getSetting('GITHUB_TOKEN')
    if (!token) {
      return NextResponse.json(
        { error: 'No GitHub token configured. Add one in Settings → GitHub Token.' },
        { status: 400 }
      )
    }

    const hookConfig = {
      url: WEBHOOK_URL,
      content_type: 'json',
      secret: webhook_secret,
      insecure_ssl: '0',
    }

    const existing = await findExistingHook(token, parsed.owner, parsed.repo)

    let hookId: number
    let action: string

    if (existing) {
      // Update to refresh the secret and ensure it's active
      const patchRes = await ghFetch(token, `/repos/${parsed.owner}/${parsed.repo}/hooks/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: true, events: ['push'], config: hookConfig }),
      })
      if (!patchRes.ok) {
        const body = await patchRes.json().catch(() => ({})) as { message?: string }
        return NextResponse.json(
          { error: `GitHub rejected update: ${body.message ?? patchRes.status}` },
          { status: 502 }
        )
      }
      hookId = existing.id
      action = 'updated'
    } else {
      // Create fresh webhook
      const createRes = await ghFetch(token, `/repos/${parsed.owner}/${parsed.repo}/hooks`, {
        method: 'POST',
        body: JSON.stringify({ name: 'web', active: true, events: ['push'], config: hookConfig }),
      })
      if (!createRes.ok) {
        const body = await createRes.json().catch(() => ({})) as { message?: string }
        if (createRes.status === 404) {
          return NextResponse.json(
            { error: `Repo "${parsed.owner}/${parsed.repo}" not found or token lacks access` },
            { status: 404 }
          )
        }
        return NextResponse.json(
          { error: `GitHub rejected creation: ${body.message ?? createRes.status}` },
          { status: 502 }
        )
      }
      const created = await createRes.json() as { id: number }
      hookId = created.id
      action = 'created'
    }

    // Audit log
    await query(
      `INSERT INTO audit_logs (user_id, action, resource, details)
       VALUES ($1, 'github_webhook_installed', $2, $3)`,
      [
        user?.id,
        `project:${context.params.id}`,
        JSON.stringify({ repo: `${parsed.owner}/${parsed.repo}`, hookId, action }),
      ]
    )

    return NextResponse.json({ installed: true, hookId, action })
  } catch (error) {
    return jsonError(error)
  }
}

// DELETE — remove the webhook from GitHub
export async function DELETE(_: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const { rows } = await query<{ repo_url: string | null }>(
      'SELECT repo_url FROM projects WHERE id = $1',
      [context.params.id]
    )
    if (rows.length === 0) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const { repo_url } = rows[0]
    if (!repo_url) return NextResponse.json({ error: 'No repo URL configured' }, { status: 400 })

    const parsed = parseRepo(repo_url)
    if (!parsed) return NextResponse.json({ error: 'Cannot parse GitHub repo URL' }, { status: 400 })

    const token = await getSetting('GITHUB_TOKEN')
    if (!token) return NextResponse.json({ error: 'No GitHub token configured' }, { status: 400 })

    const hook = await findExistingHook(token, parsed.owner, parsed.repo)
    if (!hook) return NextResponse.json({ status: 'not_found' })

    const delRes = await ghFetch(token, `/repos/${parsed.owner}/${parsed.repo}/hooks/${hook.id}`, {
      method: 'DELETE',
    })

    if (!delRes.ok && delRes.status !== 404) {
      return NextResponse.json({ error: `GitHub error: ${delRes.status}` }, { status: 502 })
    }

    return NextResponse.json({ status: 'removed', hookId: hook.id })
  } catch (error) {
    return jsonError(error)
  }
}
