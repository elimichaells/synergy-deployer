// Pure rules for moving an app's database from a superuser login to a dedicated,
// limited database user. Browser safe and unit tested.

import { hostKey } from './database-discovery-policy'

const URL_KEYS = new Set(['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING'])

/** A PostgreSQL role name derived from the database name, e.g. "trueid" -> "trueid_app". */
export function roleNameFor(database: string, taken: Set<string>) {
  const base = (database.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'app').replace(/^(\d)/, 'db_$1').slice(0, 54)
  let name = `${base}_app`
  for (let index = 2; taken.has(name); index++) name = `${base}_app${index}`
  return name
}

export function quoteIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

export interface OwnedObject { kind: string; schema: string; name: string; args?: string | null }

const KEYWORDS: Record<string, string> = {
  r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE', f: 'FOREIGN TABLE',
  schema: 'SCHEMA', function: 'FUNCTION', procedure: 'PROCEDURE', aggregate: 'AGGREGATE', type: 'TYPE', domain: 'DOMAIN',
}

/** ALTER ... OWNER TO statement for one object. */
export function ownershipStatement(object: OwnedObject, owner: string) {
  const keyword = KEYWORDS[object.kind]
  if (!keyword) throw new Error(`Unsupported object kind: ${object.kind}`)
  const target = object.kind === 'schema'
    ? quoteIdent(object.name)
    : `${quoteIdent(object.schema)}.${quoteIdent(object.name)}${['function', 'procedure', 'aggregate'].includes(object.kind) ? `(${object.args || ''})` : ''}`
  return `ALTER ${keyword} ${target} OWNER TO ${quoteIdent(owner)}`
}

export interface CredentialTarget { host: string; port: number; database: string; username: string }

function splitLine(line: string) {
  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line)
  if (!match) return null
  const [, prefix, key, separator, rest] = match
  const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : ''
  const value = quote ? rest.slice(1, rest.lastIndexOf(quote) > 0 ? rest.lastIndexOf(quote) : undefined) : rest.replace(/\s+#.*$/, '').trim()
  return { prefix, key, separator, quote, value }
}

function sameDatabase(url: URL, target: CredentialTarget) {
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] || '')
  return hostKey(url.hostname) === hostKey(target.host) && (Number(url.port) || 5432) === target.port && database === target.database
    && decodeURIComponent(url.username) === target.username
}

/**
 * Replaces the user and password for one database in an env file, leaving every
 * other line (comments, ordering, quoting) exactly as it was.
 */
export function rewriteEnvCredentials(content: string, target: CredentialTarget, username: string, password: string) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const values = new Map<string, string>()
  for (const line of lines) { const parsed = splitLine(line); if (parsed) values.set(parsed.key, parsed.value) }
  // Separate-key styles count only when every identifying key points at this database.
  const laravel = values.get('DB_DATABASE') === target.database && values.get('DB_USERNAME') === target.username
    && hostKey(values.get('DB_HOST') || '127.0.0.1') === hostKey(target.host) && (Number(values.get('DB_PORT')) || 5432) === target.port
  const plain = values.get('DATABASE_NAME') === target.database && values.get('DATABASE_USER') === target.username
    && hostKey(values.get('DATABASE_HOST') || '') === hostKey(target.host) && (Number(values.get('DATABASE_PORT')) || 5432) === target.port
  let changed = 0
  const seen = new Set<string>()
  const output = lines.map(line => {
    const parsed = splitLine(line)
    if (!parsed) return line
    let next: string | null = null
    if (URL_KEYS.has(parsed.key)) {
      try {
        const url = new URL(parsed.value)
        if (sameDatabase(url, target)) {
          next = parsed.value.replace(/^([a-z+]+:\/\/)[^@/]*@/i, `$1${encodeURIComponent(username)}:${encodeURIComponent(password)}@`)
        }
      } catch { /* not a URL */ }
    }
    if (laravel && parsed.key === 'DB_USERNAME') next = username
    if (laravel && parsed.key === 'DB_PASSWORD') next = password
    if (plain && parsed.key === 'DATABASE_USER') next = username
    if (plain && parsed.key === 'DATABASE_PASSWORD') next = password
    if (next === null || next === parsed.value) return line
    seen.add(parsed.key)
    changed++
    const quote = parsed.quote || (/[\s#"'$]/.test(next) ? '"' : '')
    return `${parsed.prefix}${parsed.key}${parsed.separator}${quote}${next}${quote}`
  })
  // A separate-key style without a password line still needs one.
  if (laravel && !seen.has('DB_PASSWORD')) { output.push(`DB_PASSWORD=${password}`); changed++ }
  if (plain && !seen.has('DATABASE_PASSWORD')) { output.push(`DATABASE_PASSWORD=${password}`); changed++ }
  return { content: output.join(newline), changed }
}
