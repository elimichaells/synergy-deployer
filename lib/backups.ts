import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readdir, stat, rm } from 'fs/promises'
import path from 'path'
import { getSetting, updateSettings } from '@/lib/settings'
import { connectionConfig, assertDatabase, createDatabase, dropDatabase, listDatabases, validateIdentifier } from '@/lib/db-admin'
import { sendNotification } from '@/lib/notify'

const BACKUP_TIMEOUT_MS = 30 * 60_000 // 30 minutes per database

// Backup file naming: <database>__<yyyy-MM-dd_HH-mm-ss>.dump
const BACKUP_FILE_PATTERN = /^([a-zA-Z_][a-zA-Z0-9_$]*)__(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.dump$/

export interface BackupFile {
  file: string
  database: string
  size_bytes: number
  created_at: string
}

async function getBackupDir(): Promise<string> {
  const dir = await getSetting('BACKUP_DIR')
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  return dir
}

async function getPgTool(tool: 'pg_dump' | 'pg_restore'): Promise<string> {
  const binPath = await getSetting('PG_BIN_PATH')
  const exe = path.join(binPath, process.platform === 'win32' ? `${tool}.exe` : tool)
  if (existsSync(exe)) return exe
  return tool // fall back to PATH
}

function runPgTool(exe: string, args: string[], password?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      output += '\n[timeout] pg tool killed after 30 minutes\n'
      resolve({ code: 1, output })
    }, BACKUP_TIMEOUT_MS)

    child.stdout.on('data', (d) => { output += d.toString() })
    child.stderr.on('data', (d) => { output += d.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: 1, output: output + `\n${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, output })
    })
  })
}

export async function listBackups(): Promise<BackupFile[]> {
  const dir = await getBackupDir()
  const entries = await readdir(dir)
  const backups: BackupFile[] = []
  for (const entry of entries) {
    const match = entry.match(BACKUP_FILE_PATTERN)
    if (!match) continue
    const info = await stat(path.join(dir, entry))
    backups.push({
      file: entry,
      database: match[1],
      size_bytes: info.size,
      created_at: info.mtime.toISOString(),
    })
  }
  return backups.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Validate a backup filename and return its absolute path (blocks path traversal) */
export async function resolveBackupFile(file: string): Promise<string> {
  if (path.basename(file) !== file || !BACKUP_FILE_PATTERN.test(file)) {
    throw new Error('Invalid backup file name')
  }
  const dir = await getBackupDir()
  const full = path.join(dir, file)
  if (!existsSync(full)) {
    throw new Error(`Backup file not found: ${file}`)
  }
  return full
}

export async function createBackup(database: string): Promise<BackupFile> {
  await assertDatabase(database)
  const dir = await getBackupDir()
  const cfg = connectionConfig(database)
  const pgDump = await getPgTool('pg_dump')

  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
  const fileName = `${database}__${stamp}.dump`
  const filePath = path.join(dir, fileName)

  const result = await runPgTool(pgDump, [
    '-h', cfg.host || 'localhost',
    '-p', String(cfg.port || 5432),
    '-U', cfg.user || 'postgres',
    '-d', database,
    '-Fc', // custom compressed format, restorable with pg_restore
    '-f', filePath,
  ], cfg.password)

  if (result.code !== 0) {
    await rm(filePath, { force: true }).catch(() => undefined)
    throw new Error(`pg_dump failed: ${result.output.slice(-500) || 'unknown error'}`)
  }

  const info = await stat(filePath)
  return { file: fileName, database, size_bytes: info.size, created_at: info.mtime.toISOString() }
}

/** Restore a backup into a NEW database (never overwrites an existing one) */
export async function restoreBackup(file: string, targetDb: string): Promise<void> {
  const nameError = validateIdentifier(targetDb, 'Target database name')
  if (nameError) throw new Error(nameError)

  const filePath = await resolveBackupFile(file)
  const pgRestore = await getPgTool('pg_restore')

  await createDatabase(targetDb) // throws if it already exists

  const cfg = connectionConfig(targetDb)
  const result = await runPgTool(pgRestore, [
    '-h', cfg.host || 'localhost',
    '-p', String(cfg.port || 5432),
    '-U', cfg.user || 'postgres',
    '-d', targetDb,
    '--no-owner',
    '--no-privileges',
    filePath,
  ], cfg.password)

  if (result.code !== 0) {
    // Clean up the partially restored database
    await dropDatabase(targetDb).catch(() => undefined)
    throw new Error(`pg_restore failed: ${result.output.slice(-500) || 'unknown error'}`)
  }
}

export async function deleteBackup(file: string): Promise<void> {
  const filePath = await resolveBackupFile(file)
  await rm(filePath, { force: true })
}

async function cleanupOldBackups(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0
  const backups = await listBackups()
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  for (const backup of backups) {
    if (new Date(backup.created_at).getTime() < cutoff) {
      await deleteBackup(backup.file).catch(() => undefined)
      removed++
    }
  }
  return removed
}

export async function cleanupDatabaseBackups(database: string, retentionCount: number): Promise<number> {
  const backups = (await listBackups()).filter((backup) => backup.database === database)
  let removed = 0
  for (const backup of backups.slice(Math.max(1, retentionCount))) {
    await deleteBackup(backup.file).catch(() => undefined)
    removed++
  }
  return removed
}

/** Nightly job: back up every database (except 'postgres'), then apply retention */
export async function runScheduledBackups(): Promise<void> {
  const databases = await listDatabases()
  const targets = databases.filter((d) => d.name !== 'postgres')
  const failures: string[] = []
  let okCount = 0

  for (const db of targets) {
    try {
      await createBackup(db.name)
      okCount++
    } catch (err) {
      failures.push(db.name)
      console.error(`[backup] Failed to back up ${db.name}:`, err)
    }
  }

  const retention = parseInt(await getSetting('BACKUP_RETENTION_DAYS'), 10) || 14
  const removed = await cleanupOldBackups(retention)

  await updateSettings({ BACKUP_LAST_RUN: new Date().toISOString() })

  if (failures.length > 0) {
    await sendNotification(
      'Postgres backup completed with errors',
      `Backed up ${okCount}/${targets.length} databases. Failed: ${failures.join(', ')}`,
      'warning'
    )
  } else {
    console.log(`[backup] Nightly run complete: ${okCount} databases backed up, ${removed} old files removed`)
  }
}

/**
 * Scheduler tick — called periodically from instrumentation. Runs the nightly
 * backup once per calendar day, in the 03:00–04:59 local window.
 */
export async function backupSchedulerTick(): Promise<void> {
  try {
    const { backupScheduleTick } = await import('@/lib/backup-schedules')
    const configuredSchedules = await backupScheduleTick()
    if (configuredSchedules > 0) return

    const enabled = await getSetting('BACKUP_ENABLED')
    if (enabled !== 'true') return

    const hour = new Date().getHours()
    if (hour < 3 || hour >= 5) return

    const lastRun = await getSetting('BACKUP_LAST_RUN')
    if (lastRun && new Date(lastRun).toDateString() === new Date().toDateString()) return

    console.log('[backup] Starting scheduled nightly backups…')
    await runScheduledBackups()
  } catch (err) {
    console.error('[backup] Scheduler tick failed:', err)
  }
}
