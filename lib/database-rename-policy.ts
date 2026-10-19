import { parseDatabaseEnv, databaseKey } from './database-discovery-policy'

/** Return setting names only; connection credentials never enter the review or history. */
export function renameEnvSettings(file: string, env: Record<string, string>, target: { host: string; port: number; database: string }) {
  const key = databaseKey('postgresql', target.host, target.port, target.database)
  const found = parseDatabaseEnv(file, env)
  for (const [name, value] of Object.entries(env)) {
    if (!/_(URL|URI)$/.test(name)) continue
    found.push(...parseDatabaseEnv(file, { DATABASE_URL: value }).map(item => ({ ...item, source: `${file}:${name}` })))
  }
  // Split settings may coexist with a URL and still need updating.
  if (env.DATABASE_NAME && env.DATABASE_HOST) found.push(...parseDatabaseEnv(file, { ...env, DATABASE_URL: '' }))
  for (const [name, value] of Object.entries(env)) {
    if (!name.endsWith('_DATABASE')) continue
    const prefix = name.slice(0, -9)
    if (!env[`${prefix}_HOST`]) continue
    found.push(...parseDatabaseEnv(file, { DATABASE_HOST: env[`${prefix}_HOST`], DATABASE_PORT: env[`${prefix}_PORT`] || '5432', DATABASE_NAME: value })
      .map(item => ({ ...item, source: `${file}:${name}` })))
  }
  return [...new Set(found.filter(item => databaseKey(item.engine, item.host, item.port, item.database) === key).map(item => {
    if (item.source === `${file}:DATABASE_*`) return `${file}:DATABASE_NAME`
    if (item.source === `${file}:DB_*`) return `${file}:${env.DB_DATABASE ? 'DB_DATABASE' : 'DB_NAME'}`
    return item.source
  }))]
}

export function renameNameError(name: unknown, oldName: string) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(name)) return 'Use 1–63 letters, digits, underscores or $, starting with a letter or underscore.'
  if (name === oldName) return 'Choose a different database name.'
  if (['postgres', 'template0', 'template1'].includes(name.toLowerCase())) return 'This database name is reserved.'
  return null
}
