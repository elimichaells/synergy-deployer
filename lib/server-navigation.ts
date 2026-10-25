export type ServerScope = { kind: 'fleet' } | { kind: 'local' } | { kind: 'remote'; id: string }

// The URL owns the context. A remembered server must never relabel local data.
export function serverScope(pathname: string): ServerScope {
  const remote = pathname.match(/^\/infrastructure\/servers\/([^/]+)(?:\/|$)/)
  if (remote) return { kind: 'remote', id: remote[1] }
  if (pathname === '/' || pathname === '/settings' || pathname === '/infrastructure/servers') return { kind: 'fleet' }
  return { kind: 'local' }
}

export function serverOverview(id: string): string {
  if (id === 'local') return '/overview'
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) return '/'
  return `/infrastructure/servers/${id}`
}

export const recentServerKey = (userId: string) => `synergy:last-server:${userId}`
