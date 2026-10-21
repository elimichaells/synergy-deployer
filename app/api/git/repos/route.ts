import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { getGitConnection, getGitHubConnectionToken } from '@/lib/github-connections'
import { listGitRepositories } from '@/lib/git-provider-api'
import { repositoryPath, repositoryUrl } from '@/lib/git-provider-policy'

export async function GET(request: Request) {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator'])
    const url = new URL(request.url)
    const id = url.searchParams.get('connectionId')
    const host = await getGitConnection(id)
    const token = await getGitHubConnectionToken(id)
    if (!token) return NextResponse.json({ connected: false, repos: [] })
    const page = Number(url.searchParams.get('page') || '1')
    if (!Number.isInteger(page) || page < 1 || page > 10000) return NextResponse.json({ error: 'Invalid page' }, { status: 400 })
    const repos = await listGitRepositories(host, token, page)
    const { rows } = await query<{ repo_url: string }>('select repo_url from projects where repo_url is not null')
    const registered = new Set(rows.flatMap(row => { try { return [repositoryUrl(row.repo_url)] } catch { return [] } }))
    const needle = (url.searchParams.get('q') || '').toLowerCase()
    return NextResponse.json({ connected: true, connectionId: id, hasMore: repos.length === 100, repos: repos.filter(repo => {
      try { repositoryPath(repo.cloneUrl, host); return repo.fullName.toLowerCase().includes(needle) } catch { return false }
    }).map(repo => ({ ...repo, registered: registered.has(repositoryUrl(repo.cloneUrl)) })) })
  } catch (error) { return jsonError(error) }
}
