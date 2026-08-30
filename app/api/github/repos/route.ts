import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { getGitHubConnectionToken } from '@/lib/github-connections'

interface GithubRepo {
  id: number
  name: string
  full_name: string
  clone_url: string
  html_url: string
  private: boolean
  default_branch: string
  updated_at: string
  owner: {
    login: string
    avatar_url: string
  }
}

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const url = new URL(request.url)
    const connectionId = url.searchParams.get('connectionId')
    const token = await getGitHubConnectionToken(connectionId || null)
    if (!token) {
      return NextResponse.json({ connected: false, repos: [] })
    }

    const q = url.searchParams.get('q')?.trim()
    const page = url.searchParams.get('page') || '1'
    const endpoint = `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100&page=${page}`

    const githubRes = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DeployManager',
      },
      cache: 'no-store',
    })

    if (githubRes.status === 401 || githubRes.status === 403) {
      return NextResponse.json({ connected: false, reason: 'token_invalid', repos: [] }, { status: 401 })
    }
    if (!githubRes.ok) {
      const body = await githubRes.json().catch(() => ({})) as { message?: string }
      return NextResponse.json({ error: body.message || `GitHub returned ${githubRes.status}` }, { status: 502 })
    }

    const data = await githubRes.json()
    const repos = (data as GithubRepo[]).filter((repo) => {
      if (!q) return true
      const needle = q.toLowerCase()
      return repo.name.toLowerCase().includes(needle) || repo.full_name.toLowerCase().includes(needle)
    })
    const { rows } = await query<{ repo_url: string | null }>('select repo_url from projects where repo_url is not null')
    const registered = new Set(rows.flatMap((row) => {
      if (!row.repo_url) return []
      return [row.repo_url, row.repo_url.replace(/\.git$/, '')]
    }))

    return NextResponse.json({
      connected: true,
      connectionId: connectionId || null,
      repos: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        avatarUrl: repo.owner.avatar_url,
        private: repo.private,
        defaultBranch: repo.default_branch,
        cloneUrl: repo.clone_url,
        htmlUrl: repo.html_url,
        updatedAt: repo.updated_at,
        registered: registered.has(repo.clone_url) || registered.has(repo.html_url),
      })),
    })
  } catch (error) {
    return jsonError(error)
  }
}
