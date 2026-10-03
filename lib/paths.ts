import { existsSync, readdirSync } from 'fs'
import path from 'path'

/**
 * Where the manager and the things it manages live. Every location derives from the install
 * folders the installer chose (written to .env.local), so the manager runs from any folder on any
 * Windows machine. Without settings, the defaults match the original layout: the manager in
 * <web root>\manager, apps, tools, logs and backups beside it.
 */

type Env = Record<string, string | undefined>
const set = (value: string | undefined) => value && value.trim() ? value.trim() : undefined

export function managerRoot(env: Env = process.env, cwd = process.cwd()) {
  return set(env.MANAGER_ROOT) || cwd
}

export function webRoot(env: Env = process.env, cwd = process.cwd()) {
  return set(env.MANAGER_WEB_ROOT) || set(env.CADDY_PATH) || path.dirname(managerRoot(env, cwd))
}

export function toolsRoot(env: Env = process.env, cwd = process.cwd()) {
  return set(env.MANAGER_TOOLS_ROOT) || path.join(webRoot(env, cwd), 'tools')
}

export function backupsRoot(env: Env = process.env, cwd = process.cwd()) {
  return path.join(webRoot(env, cwd), 'backups')
}

/** Where app env files are copied before the manager rewrites them. */
export function envBackupDir(env: Env = process.env, cwd = process.cwd()) {
  return set(env.MANAGER_ENV_BACKUP_DIR) || path.join(backupsRoot(env, cwd), 'manager-env')
}

export function managerScript(name: string, env: Env = process.env, cwd = process.cwd()) {
  return path.join(managerRoot(env, cwd), 'scripts', name)
}

/** Manager state outside the web root, such as job folders. */
export function managerDataRoot(env: Env = process.env) {
  return path.join(set(env.PROGRAMDATA) || set(env.ProgramData) || 'C:\\ProgramData', 'Manager')
}

const LEGACY_CADDY_LOGS = 'C:\\Caddy\\logs'

/** Caddy's per-site error logs: the configured folder, the original one if it exists, otherwise beside the other logs. */
export function caddyLogDir(env: Env = process.env, cwd = process.cwd(), exists: (file: string) => boolean = existsSync) {
  return set(env.CADDY_LOG_DIR) || (exists(LEGACY_CADDY_LOGS) ? LEGACY_CADDY_LOGS : path.join(webRoot(env, cwd), 'logs', 'caddy'))
}

interface Probe { exists: (file: string) => boolean; list: (dir: string) => string[] }
const realProbe: Probe = { exists: existsSync, list: dir => { try { return readdirSync(dir) } catch { return [] } } }

/** The newest installed PostgreSQL's bin folder, or the configured one. */
export function postgresBin(env: Env = process.env, probe: Probe = realProbe): string | null {
  if (set(env.PG_BIN_PATH)) return set(env.PG_BIN_PATH)!
  const root = path.join(set(env.ProgramFiles) || 'C:\\Program Files', 'PostgreSQL')
  const versions = probe.list(root).filter(name => /^\d+(\.\d+)?$/.test(name)).sort((a, b) => Number(b) - Number(a))
  for (const version of versions) {
    const bin = path.join(root, version, 'bin')
    if (probe.exists(path.join(bin, 'psql.exe'))) return bin
  }
  return null
}

/** MySQL or MariaDB client tools, wherever they were installed. */
export function mysqlBin(env: Env = process.env, probe: Probe = realProbe): string | null {
  if (set(env.MYSQL_BIN_PATH)) return set(env.MYSQL_BIN_PATH)!
  const candidates = [path.join('C:\\tools', 'mysql', 'current', 'bin')]
  for (const parent of [path.join(set(env.ProgramFiles) || 'C:\\Program Files', 'MySQL'), path.join(set(env.ProgramFiles) || 'C:\\Program Files', 'MariaDB')]) {
    for (const name of probe.list(parent).sort().reverse()) candidates.push(path.join(parent, name, 'bin'))
  }
  return candidates.find(bin => probe.exists(path.join(bin, 'mysql.exe'))) ?? null
}

/** Extra folders on PATH for the commands the manager runs, only those present on this machine. */
export function toolPathEntries(env: Env = process.env, probe: Probe = realProbe): string[] {
  const programFiles = set(env.ProgramFiles) || 'C:\\Program Files'
  const entries = [
    path.join(programFiles, 'Go', 'bin'),
    postgresBin(env, probe),
    path.join(set(env.ChocolateyInstall) || 'C:\\ProgramData\\chocolatey', 'bin'),
    mysqlBin(env, probe),
    set(env.APPDATA) ? path.join(env.APPDATA!, 'npm') : null,
  ]
  return entries.filter((entry): entry is string => !!entry && probe.exists(entry))
}
