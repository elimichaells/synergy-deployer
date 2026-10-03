// Pure rules for moving a PostgreSQL database to another server. Browser safe and unit tested.

import { hostKey } from './database-discovery-policy'
import type { CredentialTarget } from './dedicated-user-policy'

const URL_KEYS = new Set(['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING', 'DIRECT_URL'])

export interface NewLocation { host: string; port: number; database: string; username: string; password: string }

function splitLine(line: string) {
  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line)
  if (!match) return null
  const [, prefix, key, separator, rest] = match
  const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : ''
  const value = quote ? rest.slice(1, rest.lastIndexOf(quote) > 0 ? rest.lastIndexOf(quote) : undefined) : rest.replace(/\s+#.*$/, '').trim()
  return { prefix, key, separator, quote, value }
}

function pointsAt(url: URL, from: CredentialTarget) {
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] || '')
  return /^postgres(ql)?:$/i.test(url.protocol) && hostKey(url.hostname) === hostKey(from.host) && (Number(url.port) || 5432) === from.port
    && database === from.database && (!from.username || decodeURIComponent(url.username) === from.username)
}

/**
 * Points every setting for one database at its new server, database name and login, keeping every
 * other line, and the query options of connection URLs (schema, pool size, SSL), exactly as they were.
 */
export function rewriteEnvLocation(content: string, from: CredentialTarget, to: NewLocation) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const values = new Map<string, string>()
  for (const line of lines) { const parsed = splitLine(line); if (parsed) values.set(parsed.key, parsed.value) }
  const separate = (host: string, port: string, database: string, user: string) =>
    values.get(database) === from.database && (!from.username || values.get(user) === from.username)
    && hostKey(values.get(host) || '127.0.0.1') === hostKey(from.host) && (Number(values.get(port)) || 5432) === from.port
  const laravel = separate('DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME')
  const plain = separate('DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER')
  const replacements: Record<string, string> = {
    ...(laravel ? { DB_HOST: to.host, DB_PORT: String(to.port), DB_DATABASE: to.database, DB_USERNAME: to.username, DB_PASSWORD: to.password } : {}),
    ...(plain ? { DATABASE_HOST: to.host, DATABASE_PORT: String(to.port), DATABASE_NAME: to.database, DATABASE_USER: to.username, DATABASE_PASSWORD: to.password } : {}),
  }
  let changed = 0
  const seen = new Set<string>()
  const output = lines.map(line => {
    const parsed = splitLine(line)
    if (!parsed) return line
    let next: string | null = null
    if (URL_KEYS.has(parsed.key)) {
      try {
        const url = new URL(parsed.value)
        if (pointsAt(url, from)) {
          const query = parsed.value.includes('?') ? parsed.value.slice(parsed.value.indexOf('?')) : ''
          next = `${url.protocol}//${encodeURIComponent(to.username)}:${encodeURIComponent(to.password)}@${to.host}:${to.port}/${encodeURIComponent(to.database)}${query}`
        }
      } catch { /* not a URL */ }
    }
    if (parsed.key in replacements) next = replacements[parsed.key]
    if (next === null) return line
    seen.add(parsed.key)
    if (next === parsed.value) return line
    changed++
    const quote = parsed.quote || (/[\s#"'$]/.test(next) ? '"' : '')
    return `${parsed.prefix}${parsed.key}${parsed.separator}${quote}${next}${quote}`
  })
  // Separate-key styles without a password line still need one.
  for (const key of ['DB_PASSWORD', 'DATABASE_PASSWORD']) {
    if (key in replacements && !seen.has(key)) { output.push(`${key}=${replacements[key]}`); changed++ }
  }
  return { content: output.join(newline), changed }
}

/**
 * Extensions are created by the server's admin before the restore, so the restore itself (which
 * runs as the new, limited login) skips them and their comments.
 */
export function filterRestoreList(list: string) {
  return list.split(/\r?\n/).filter(line => !/^\s*\d+;\s*\d+\s+\d+\s+(EXTENSION -|COMMENT - EXTENSION)\s/.test(line)).join('\n')
}

export interface CopyFacts {
  /** Exact row count per schema.table. */
  rows: Record<string, number>
  /** Last value per schema.sequence (null when never used). */
  sequences: Record<string, number | null>
  /** Count of views, functions, types and indexes by kind. */
  objects: Record<string, number>
}

/** Every difference between the original and the copy; empty means the copy is exact. */
export function compareCopies(source: CopyFacts, target: CopyFacts) {
  const differences: string[] = []
  for (const [table, count] of Object.entries(source.rows)) {
    if (!(table in target.rows)) differences.push(`Table ${table} is missing from the copy`)
    else if (target.rows[table] !== count) differences.push(`Table ${table} has ${target.rows[table]} rows in the copy and ${count} in the original`)
  }
  for (const table of Object.keys(target.rows)) if (!(table in source.rows)) differences.push(`Table ${table} exists only in the copy`)
  for (const [sequence, value] of Object.entries(source.sequences)) {
    if (!(sequence in target.sequences)) differences.push(`Sequence ${sequence} is missing from the copy`)
    else if (target.sequences[sequence] !== value) differences.push(`Sequence ${sequence} is at ${target.sequences[sequence]} in the copy and ${value} in the original`)
  }
  for (const [kind, count] of Object.entries(source.objects)) {
    if ((target.objects[kind] ?? 0) !== count) differences.push(`${count} ${kind} in the original, ${target.objects[kind] ?? 0} in the copy`)
  }
  return differences
}

/** A cautious range for the downtime: the app is stopped while the data is copied and checked. */
export function estimateMoveMinutes(bytes: number) {
  const gb = bytes / 1024 ** 3
  const low = Math.max(1, Math.round(gb * 1.2 + 0.5))
  const high = Math.max(2, Math.round(gb * 3 + 1))
  return { low, high }
}

export function moveTargetName(database: string, taken: Set<string>) {
  let name = database
  for (let index = 2; taken.has(name); index++) name = `${database}_${index}`
  return name
}
