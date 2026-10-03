/** What to change in a database server's memory settings, and why. Pure and testable. */

export interface Recommendation {
  key: 'performance_schema' | 'mysqlx' | 'innodb_log_buffer_size'
  current: string
  recommended: string
  /** Memory this frees, measured where the server reports it, otherwise a typical figure. */
  savingMb: number
  measured: boolean
  title: string
  why: string
}

export interface MysqlFacts {
  engine: 'mysql' | 'mariadb'
  /** SHOW GLOBAL VARIABLES, lower-case names. */
  variables: Record<string, string>
  /** SHOW GLOBAL STATUS, lower-case names. */
  status: Record<string, string>
  /** Memory the performance schema itself holds, when it can be read. */
  performanceSchemaMb: number | null
  xPluginActive: boolean
}

const mb = (bytes: string | undefined) => bytes ? Math.round(Number(bytes) / 1024 / 1024) : 0

export function mysqlRecommendations(facts: MysqlFacts): Recommendation[] {
  const out: Recommendation[] = []
  if ((facts.variables.performance_schema || '').toUpperCase() === 'ON') {
    out.push({
      key: 'performance_schema', current: 'ON', recommended: 'OFF',
      savingMb: facts.performanceSchemaMb ?? 200, measured: facts.performanceSchemaMb !== null,
      title: 'Turn off detailed performance monitoring',
      why: 'MySQL keeps statistics about every query in memory all the time. They help when tracking down a slow query; you can turn them back on for that.',
    })
  }
  if (facts.engine === 'mysql' && facts.xPluginActive && Number(facts.status.mysqlx_connections_accepted || 0) === 0) {
    out.push({
      key: 'mysqlx', current: 'ON', recommended: 'OFF', savingMb: 20, measured: false,
      title: 'Turn off the unused X protocol',
      why: 'A second way to connect (port 33060), used by MySQL Shell and document-store apps. Nothing has connected to it since MySQL started; apps use port 3306.',
    })
  }
  const logBuffer = mb(facts.variables.innodb_log_buffer_size)
  if (logBuffer > 16) {
    out.push({
      key: 'innodb_log_buffer_size', current: `${logBuffer}M`, recommended: '16M', savingMb: logBuffer - 16, measured: true,
      title: 'Shrink the change buffer',
      why: 'Holds changes before they are written to disk. 16 MB is plenty unless an app writes large amounts of data at once.',
    })
  }
  return out
}

/** The settings string the tuning script takes, for the chosen recommendations only. */
export function tuningSettings(recommendations: Recommendation[], keys: unknown): string {
  if (!Array.isArray(keys) || !keys.length) throw new Error('Choose at least one change')
  const chosen = recommendations.filter(item => keys.includes(item.key))
  if (chosen.length !== new Set(keys).size) throw new Error('A chosen change is no longer recommended; refresh and try again')
  return chosen.map(item => `${item.key}=${item.recommended}`).join(';')
}

export interface ConnectionGroup { login: string; database: string; state: string; count: number }

/** Logins that keep many idle connections open; each costs a few megabytes on the database server. */
export function idleConnectionNotes(groups: ConnectionGroup[], threshold = 5) {
  const idle = new Map<string, number>()
  for (const group of groups) if (group.state === 'idle') idle.set(`${group.login}@${group.database}`, (idle.get(`${group.login}@${group.database}`) ?? 0) + group.count)
  return [...idle].filter(([, count]) => count >= threshold).sort((a, b) => b[1] - a[1])
    .map(([who, count]) => `${who} keeps ${count} idle connections open. If the app uses Prisma, adding connection_limit=5 to its DATABASE_URL lowers this.`)
}

export function engineFromServicePath(pathName: string): string | null {
  if (/mariadbd/i.test(pathName) || /mariadb/i.test(pathName) && /mysqld/i.test(pathName)) return 'mariadb'
  if (/mysqld/i.test(pathName)) return 'mysql'
  if (/pg_ctl|postgres/i.test(pathName)) return 'postgresql'
  if (/memurai|redis-server/i.test(pathName)) return 'redis'
  if (/mongod/i.test(pathName)) return 'mongodb'
  return null
}
