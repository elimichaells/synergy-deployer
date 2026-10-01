// Pure parsing of the database settings an application already uses, read from
// its environment files. Browser safe; never returns passwords to callers that
// only need to describe a database.

export type DiscoveredEngine = 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver' | 'mongodb' | 'redis'

export interface DiscoveredDatabase {
  source: string
  engine: DiscoveredEngine
  host: string
  port: number
  database: string
  username: string | null
  password: string | null
  tls: boolean
}

export const DEFAULT_PORTS: Record<DiscoveredEngine, number> = { postgresql: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, mongodb: 27017, redis: 6379 }
const URL_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'MONGODB_URI', 'MONGO_URL', 'MONGO_URI', 'REDIS_URL']
const PROTOCOLS: Record<string, DiscoveredEngine> = {
  postgres: 'postgresql', postgresql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', sqlserver: 'sqlserver', mssql: 'sqlserver',
  mongodb: 'mongodb', 'mongodb+srv': 'mongodb', redis: 'redis', rediss: 'redis',
}
const LARAVEL_DRIVERS: Record<string, DiscoveredEngine> = { pgsql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', sqlsrv: 'sqlserver' }

/** localhost, 127.0.0.1 and ::1 all mean "this machine". */
export function hostKey(host: string) {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(value) ? 'local' : value
}

export function databaseKey(engine: string, host: string, port: number, database: string) {
  return `${engine}|${hostKey(host)}|${port}|${database}`
}

function fromUrl(source: string, value: string): DiscoveredDatabase | null {
  let url: URL
  try { url = new URL(value.trim()) } catch { return null }
  const engine = PROTOCOLS[url.protocol.replace(/:$/, '').toLowerCase()]
  if (!engine || !url.hostname) return null
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] || '') || (engine === 'redis' ? '0' : '')
  if (!database) return null
  const sslmode = url.searchParams.get('sslmode') || url.searchParams.get('ssl') || ''
  return {
    source, engine, host: url.hostname, port: Number(url.port) || DEFAULT_PORTS[engine], database,
    username: url.username ? decodeURIComponent(url.username) : null, password: url.password ? decodeURIComponent(url.password) : null,
    tls: url.protocol === 'rediss:' || ['require', 'verify-ca', 'verify-full', 'true'].includes(sslmode.toLowerCase()),
  }
}

/** Finds every database an environment file points at, most specific first. */
export function parseDatabaseEnv(file: string, env: Record<string, string>): DiscoveredDatabase[] {
  const found: DiscoveredDatabase[] = []
  for (const key of URL_KEYS) {
    if (env[key]) { const item = fromUrl(`${file}:${key}`, env[key]); if (item) found.push(item) }
  }
  // Laravel style: DB_CONNECTION plus DB_HOST / DB_DATABASE / DB_USERNAME / DB_PASSWORD.
  const name = env.DB_DATABASE || env.DB_NAME
  const driver = LARAVEL_DRIVERS[(env.DB_CONNECTION || '').toLowerCase()] || (env.DB_DRIVER === 'postgres' ? 'postgresql' : undefined)
  if (name && (driver || env.DB_HOST)) {
    const engine: DiscoveredEngine = driver || 'postgresql'
    found.push({ source: `${file}:DB_*`, engine, host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT) || DEFAULT_PORTS[engine], database: name,
      username: env.DB_USERNAME || env.DB_USER || null, password: env.DB_PASSWORD ?? null, tls: false })
  }
  // Plain DATABASE_HOST / DATABASE_NAME style used by some Node and Go apps.
  if (env.DATABASE_NAME && env.DATABASE_HOST && !env.DATABASE_URL) {
    found.push({ source: `${file}:DATABASE_*`, engine: 'postgresql', host: env.DATABASE_HOST, port: Number(env.DATABASE_PORT) || 5432, database: env.DATABASE_NAME,
      username: env.DATABASE_USER || null, password: env.DATABASE_PASSWORD ?? null, tls: false })
  }
  return found
}

/** Merges several env files, keeping the first occurrence of each physical database. */
export function uniqueDatabases(items: DiscoveredDatabase[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = `${databaseKey(item.engine, item.host, item.port, item.database)}|${item.username || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
