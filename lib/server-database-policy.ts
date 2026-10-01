/** Rules for databases that sit on a server without being tracked by any app. */

const SERVER_PREFIX = 'server~'

/** A stable id for "this database on this server", for databases no app tracks. */
export function serverDatabaseId(connectionId: string, database: string) {
  // encodeURIComponent leaves "~" alone, but it separates the parts of the id.
  return `${SERVER_PREFIX}${connectionId}~${encodeURIComponent(database).replace(/~/g, '%7E')}`
}

export function parseServerDatabaseId(id: string): { connectionId: string; database: string } | null {
  if (!id.startsWith(SERVER_PREFIX)) return null
  const [connectionId, encoded, ...extra] = id.slice(SERVER_PREFIX.length).split('~')
  if (!connectionId || !encoded || extra.length) return null
  try {
    const database = decodeURIComponent(encoded)
    return database ? { connectionId, database } : null
  } catch { return null }
}

/** Databases that must never be dropped from the manager. */
export function isProtectedDatabase(name: string, controlDatabase: string, isSystemServer: boolean) {
  if (['postgres', 'template0', 'template1'].includes(name)) return true
  return isSystemServer && name === controlDatabase
}

/** Why a database cannot be dropped, or null when it can. */
export function dropBlocker(input: { name: string; controlDatabase: string; isSystemServer: boolean; trackedBy: string[]; usedBy: string[] }) {
  if (isProtectedDatabase(input.name, input.controlDatabase, input.isSystemServer)) return 'This database is protected. Synergy needs it.'
  if (input.trackedBy.length) return `${input.trackedBy.join(', ')} ${input.trackedBy.length === 1 ? 'uses' : 'use'} this database. Disconnect it from the app first.`
  if (input.usedBy.length) return `${input.usedBy.join(', ')} ${input.usedBy.length === 1 ? 'is' : 'are'} configured to use this database. Point the app elsewhere first.`
  return null
}
