import { request as httpsRequest } from 'node:https'
import { rootCertificates, createSecureContext } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { gitHost, type GitHost } from './git-provider-policy'

export function validateGitCa(value: unknown): string | null {
  const pem = String(value || '').trim()
  if (!pem) return null
  if (pem.length > 65536 || /PRIVATE KEY/.test(pem)) throw new Error('Supply only public CA certificates in PEM format (maximum 64 KiB)')
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!certs?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error('Invalid CA certificate PEM')
  for (const cert of certs) new X509Certificate(cert)
  createSecureContext({ ca: pem })
  return pem
}

export function gitApiRoot(host: GitHost) {
  return host.provider === 'github' ? 'https://api.github.com' : host.base_url + (host.provider === 'gitlab' ? '/api/v4' : '/api/v1')
}

/** Never follow an authenticated redirect. Private LAN addresses are intentional, administrator-configured destinations. */
export async function gitApi(host: GitHost, token: string, resource: string, options: { method?: string; body?: unknown } = {}) {
  gitHost(host.provider, host.base_url)
  if (!resource.startsWith('/') || resource.startsWith('//')) throw new Error('Invalid Git API resource')
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'SynergyDeployer' }
  if (host.provider === 'gitlab') headers['PRIVATE-TOKEN'] = token
  else headers.Authorization = `${host.provider === 'gitea' ? 'token' : 'Bearer'} ${token}`
  if (host.provider === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28'
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)) }
  return new Promise<{ status: number; ok: boolean; data: any; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpsRequest(gitApiRoot(host) + resource, { method: options.method || 'GET', headers,
      ca: host.ca_pem ? [...rootCertificates, host.ca_pem] : undefined, rejectUnauthorized: true }, res => {
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(new Error('Git API response is too large')); else chunks.push(chunk) })
      res.on('error', () => reject(new Error('Git API response interrupted')))
      res.on('end', () => {
        const status = res.statusCode || 502
        try { resolve({ status, ok: status >= 200 && status < 300, data: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null, headers: res.headers }) }
        catch { reject(new Error(`Git server returned an invalid API response (HTTP ${status})`)) }
      })
    })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 30000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', () => reject(new Error('Cannot reach the Git server securely. Check its address, network access and CA certificate.')))
    req.end(body)
  })
}

export async function inspectGitToken(host: GitHost, token: string) {
  if (!token || /[\r\n\x00]/.test(token)) throw new Error('A valid access token is required')
  const res = await gitApi(host, token, '/user')
  if (!res.ok) throw new Error(`${host.provider} rejected this token (HTTP ${res.status})`)
  const login = host.provider === 'gitlab' ? res.data.username : res.data.login
  if (!login || /[:\r\n]/.test(login)) throw new Error('Git server did not return a valid account')
  return { account: { login: String(login), name: res.data.name || res.data.full_name || null, avatar_url: res.data.avatar_url || null },
    scopes: String(res.headers['x-oauth-scopes'] || '').split(',').map(s => s.trim()).filter(Boolean) }
}

export async function listGitRepositories(host: GitHost, token: string, page: number) {
  const endpoint = host.provider === 'gitlab' ? `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`
    : host.provider === 'gitea' ? `/user/repos?limit=100&page=${page}`
      : `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100&page=${page}`
  const res = await gitApi(host, token, endpoint)
  if (!res.ok || !Array.isArray(res.data)) throw new Error(`Could not list ${host.provider} repositories (HTTP ${res.status})`)
  return res.data.map(repo => ({ id: repo.id, name: repo.name, fullName: repo.path_with_namespace || repo.full_name,
    owner: repo.namespace?.full_path || repo.owner?.login, avatarUrl: repo.avatar_url || repo.owner?.avatar_url,
    private: host.provider === 'gitlab' ? repo.visibility !== 'public' : repo.private,
    defaultBranch: repo.default_branch || 'main', cloneUrl: repo.http_url_to_repo || repo.clone_url,
    htmlUrl: repo.web_url || repo.html_url, updatedAt: repo.last_activity_at || repo.updated_at }))
}
