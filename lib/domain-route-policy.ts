// Pure rules for routing a path of one stack application's domain to another
// stack application (for example app.example.com/api -> backend). Browser safe.

const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/i
const RESERVED = ['/.well-known']

export function normalizeRoutePrefix(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const prefix = ('/' + raw.replace(/^\/+/, '')).replace(/\/+$/, '').replace(/\/\*$/, '')
  const segments = prefix.split('/').slice(1)
  if (!segments.length || segments.some(segment => !SEGMENT.test(segment))) {
    throw new Error('Use a path like /api: letters, numbers, dots, dashes and underscores only')
  }
  if (prefix.length > 100) throw new Error('Path prefix is too long')
  if (RESERVED.some(reserved => prefix === reserved || prefix.startsWith(reserved + '/'))) throw new Error('This path is reserved for certificate validation')
  return prefix.toLowerCase()
}

export interface StackRouteFacts {
  domainProjectId: string
  domainGroupId: string | null
  domainEnvironment: string
  targetProjectId: string
  targetGroupId: string | null
  targetEnvironment: string
  targetPort: number | null
}

export function stackRouteProblem(facts: StackRouteFacts) {
  if (facts.domainProjectId === facts.targetProjectId) return 'The domain already serves this application; choose another stack application'
  if (!facts.domainGroupId || facts.domainGroupId !== facts.targetGroupId) return 'Only applications in the same stack can share a domain'
  if (facts.domainEnvironment !== facts.targetEnvironment) return 'Production and staging applications cannot share a domain'
  if (!facts.targetPort) return 'Assign the application a port before routing traffic to it'
  return null
}

/** Longest prefixes first so /api/v2 wins over /api inside Caddy's ordered handle blocks. */
export function orderRoutes<T extends { path_prefix: string }>(routes: T[]) {
  return [...routes].sort((a, b) => b.path_prefix.length - a.path_prefix.length || a.path_prefix.localeCompare(b.path_prefix))
}
