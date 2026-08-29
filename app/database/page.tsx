'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Database,
  Table2,
  RefreshCw,
  Play,
  ChevronLeft,
  ChevronRight,
  Lock,
  Unlock,
  HardDrive,
  Users,
  Plus,
  Trash2,
  Copy,
  Check,
  KeyRound,
  Archive,
  Download,
  History,
  CalendarClock,
  Pencil
} from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import Link from 'next/link'

interface DatabaseInfo {
  name: string
  size_bytes: number
  size_pretty: string
  connections: number
}

interface ProjectDatabaseLink {
  project_id: string
  project_name: string
  environment: 'production' | 'staging'
  database_name: string
  role_name: string
}

interface TableInfo {
  schema: string
  name: string
  est_rows: number
  size_pretty: string
}

interface ColumnInfo {
  name: string
  type: string
}

interface RowsResult {
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
}

interface SqlResult {
  command: string
  rowCount: number
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  truncated: boolean
  durationMs: number
}

interface SessionUser {
  id: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

interface BackupFile {
  file: string
  database: string
  size_bytes: number
  created_at: string
}

type BackupFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
interface BackupSchedule {
  id: string
  database_name: string
  frequency: BackupFrequency
  time_of_day: string
  timezone: string
  day_of_week: number
  day_of_month: number
  month_of_year: number
  retention_count: number
  enabled: boolean
  next_run_at: string | null
  last_status: 'idle' | 'running' | 'success' | 'failed' | 'interrupted'
  last_file: string | null
  last_error: string | null
}

const backupTimezones = ['UTC', 'Africa/Accra', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai']
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const emptyBackupSchedule = {
  database: '', frequency: 'daily' as BackupFrequency, timeOfDay: '03:00', timezone: 'UTC',
  dayOfWeek: 0, dayOfMonth: 1, monthOfYear: 1, retentionCount: 30, enabled: true,
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function backupScheduleLabel(schedule: BackupSchedule) {
  if (schedule.frequency === 'daily') return `Daily at ${schedule.time_of_day}`
  if (schedule.frequency === 'weekly') return `${weekdays[schedule.day_of_week]} at ${schedule.time_of_day}`
  if (schedule.frequency === 'monthly') return `Day ${schedule.day_of_month} monthly at ${schedule.time_of_day}`
  return `${months[schedule.month_of_year - 1]} ${schedule.day_of_month} yearly at ${schedule.time_of_day}`
}

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="italic text-zinc-600">NULL</span>
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-emerald-400' : 'text-orange-400'}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="text-violet-300">{String(value)}</span>
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return <span className="text-cyan-300" title={json}>{json.length > 120 ? `${json.slice(0, 120)}…` : json}</span>
  }
  const str = String(value)
  return <span title={str.length > 120 ? str : undefined}>{str.length > 120 ? `${str.slice(0, 120)}…` : str}</span>
}

function ResultsGrid({ columns, rows }: { columns: ColumnInfo[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0) return null
  return (
    <div className="overflow-auto rounded-lg border border-white/[0.08]">
      <table className="w-full min-w-max border-collapse text-left font-mono text-xs">
        <thead className="sticky top-0 bg-[#101318]">
          <tr>
            {columns.map((col) => (
              <th key={col.name} className="border-b border-white/10 px-3 py-2 font-semibold text-foreground whitespace-nowrap">
                {col.name}
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">{col.type}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center italic text-muted-foreground">
                No rows
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} className="transition-colors hover:bg-white/[0.03]">
                {columns.map((col) => (
                  <td key={col.name} className="max-w-md truncate px-3 py-1.5 text-[#c9cbd1] whitespace-nowrap">
                    <CellValue value={row[col.name]} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export default function DatabasePage() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [userLoaded, setUserLoaded] = useState(false)
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [projectDatabases, setProjectDatabases] = useState<ProjectDatabaseLink[]>([])
  const [selectedDb, setSelectedDb] = useState<string | null>(null)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [selectedTable, setSelectedTable] = useState<{ schema: string; name: string } | null>(null)
  const [rowsResult, setRowsResult] = useState<RowsResult | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('browse')

  const [sql, setSql] = useState('')
  const [sqlResult, setSqlResult] = useState<SqlResult | null>(null)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [sqlRunning, setSqlRunning] = useState(false)
  const [allowWrites, setAllowWrites] = useState(false)

  const [protectedDbs, setProtectedDbs] = useState<string[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createWithOwner, setCreateWithOwner] = useState(true)
  const [createOwnerName, setCreateOwnerName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdCreds, setCreatedCreds] = useState<{ database: string; username?: string; password?: string } | null>(null)
  const [credsCopied, setCredsCopied] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dropConfirm, setDropConfirm] = useState('')
  const [dropping, setDropping] = useState(false)

  const [backups, setBackups] = useState<BackupFile[]>([])
  const [backupSchedules, setBackupSchedules] = useState<BackupSchedule[]>([])
  const [backupScheduleEditor, setBackupScheduleEditor] = useState<BackupSchedule | 'new' | null>(null)
  const [backupScheduleForm, setBackupScheduleForm] = useState(emptyBackupSchedule)
  const [backupScheduleBusy, setBackupScheduleBusy] = useState<string | null>(null)
  const [backupDbChoice, setBackupDbChoice] = useState('')
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [backupNotice, setBackupNotice] = useState<string | null>(null)
  const [restoreFile, setRestoreFile] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null)
  const deepLinkHandled = useRef(false)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : { user: null }))
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setUserLoaded(true))
  }, [])

  const loadDatabases = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/db')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load databases')
      }
      const data = await res.json()
      setDatabases(data.databases || [])
      setProjectDatabases(data.projectDatabases || [])
      setProtectedDbs(data.protected || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load databases')
    }
  }, [])

  const handleCreateDatabase = async () => {
    const name = createName.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          withOwner: createWithOwner,
          ownerName: createOwnerName.trim() || undefined,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Failed to create database')
      setCreatedCreds({ database: body.database, username: body.owner?.username, password: body.owner?.password })
      setCreateName('')
      setCreateOwnerName('')
      await loadDatabases()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create database')
    } finally {
      setCreating(false)
    }
  }

  const handleCopyCreds = async () => {
    if (!createdCreds) return
    const text = createdCreds.username
      ? `DATABASE=${createdCreds.database}\nUSERNAME=${createdCreds.username}\nPASSWORD=${createdCreds.password}\nDATABASE_URL=postgres://${createdCreds.username}:${createdCreds.password}@localhost:5432/${createdCreds.database}`
      : `DATABASE=${createdCreds.database}`
    await navigator.clipboard.writeText(text)
    setCredsCopied(true)
    setTimeout(() => setCredsCopied(false), 2000)
  }

  const handleDropDatabase = async () => {
    if (!dropTarget || dropConfirm !== dropTarget || dropping) return
    setDropping(true)
    setError(null)
    try {
      const res = await fetch(`/api/db/${encodeURIComponent(dropTarget)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: dropConfirm }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Failed to drop database')
      if (selectedDb === dropTarget) {
        setSelectedDb(null)
        setTables([])
        setSelectedTable(null)
        setRowsResult(null)
      }
      setDropTarget(null)
      setDropConfirm('')
      await loadDatabases()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to drop database')
    } finally {
      setDropping(false)
    }
  }

  useEffect(() => {
    if (user?.role === 'admin') void loadDatabases()
  }, [user, loadDatabases])

  const selectDatabase = useCallback(async (name: string) => {
    setSelectedDb(name)
    setSelectedTable(null)
    setRowsResult(null)
    setSqlResult(null)
    setSqlError(null)
    setTablesLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/db/${encodeURIComponent(name)}/tables`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load tables')
      }
      const data = await res.json()
      setTables(data.tables || [])
    } catch (err) {
      setTables([])
      setError(err instanceof Error ? err.message : 'Failed to load tables')
    } finally {
      setTablesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (deepLinkHandled.current || databases.length === 0) return
    const requested = new URLSearchParams(window.location.search).get('database')
    deepLinkHandled.current = true
    if (requested && databases.some((database) => database.name === requested)) {
      void selectDatabase(requested)
    }
  }, [databases, selectDatabase])

  const loadRows = useCallback(async (db: string, schema: string, table: string, page: number) => {
    setRowsLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/db/${encodeURIComponent(db)}/rows?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&page=${page}&pageSize=50`
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load rows')
      }
      setRowsResult(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rows')
    } finally {
      setRowsLoading(false)
    }
  }, [])

  const selectTable = (schema: string, name: string) => {
    setSelectedTable({ schema, name })
    setTab('browse')
    if (selectedDb) void loadRows(selectedDb, schema, name, 1)
  }

  const runSql = async () => {
    if (!selectedDb || !sql.trim() || sqlRunning) return
    setSqlRunning(true)
    setSqlError(null)
    setSqlResult(null)
    try {
      const res = await fetch(`/api/db/${encodeURIComponent(selectedDb)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, allowWrites }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Query failed')
      setSqlResult(body)
    } catch (err) {
      setSqlError(err instanceof Error ? err.message : 'Query failed')
    } finally {
      setSqlRunning(false)
    }
  }

  const loadBackups = useCallback(async () => {
    try {
      const [backupsRes, schedulesRes] = await Promise.all([
        fetch('/api/db/backups'),
        fetch('/api/db/backups/schedules'),
      ])
      if (backupsRes.ok) setBackups((await backupsRes.json()).backups || [])
      if (schedulesRes.ok) setBackupSchedules((await schedulesRes.json()).schedules || [])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (user?.role === 'admin') void loadBackups()
  }, [user, loadBackups])

  useEffect(() => {
    if (!backupSchedules.some((schedule) => schedule.last_status === 'running')) return
    const timer = window.setInterval(() => void loadBackups(), 5000)
    return () => window.clearInterval(timer)
  }, [backupSchedules, loadBackups])

  const openBackupSchedule = (schedule: BackupSchedule | 'new') => {
    setBackupScheduleEditor(schedule)
    setBackupScheduleForm(schedule === 'new' ? {
      ...emptyBackupSchedule,
      database: backupDbChoice || selectedDb || '',
    } : {
      database: schedule.database_name,
      frequency: schedule.frequency,
      timeOfDay: schedule.time_of_day,
      timezone: schedule.timezone,
      dayOfWeek: schedule.day_of_week,
      dayOfMonth: schedule.day_of_month,
      monthOfYear: schedule.month_of_year,
      retentionCount: schedule.retention_count,
      enabled: schedule.enabled,
    })
  }

  const saveBackupSchedule = async () => {
    if (!backupScheduleEditor || backupScheduleBusy) return
    setBackupScheduleBusy('save')
    setError(null)
    try {
      const isNew = backupScheduleEditor === 'new'
      const res = await fetch(isNew ? '/api/db/backups/schedules' : `/api/db/backups/schedules/${backupScheduleEditor.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backupScheduleForm),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Failed to save backup schedule')
      setBackupScheduleEditor(null)
      await loadBackups()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save backup schedule')
    } finally {
      setBackupScheduleBusy(null)
    }
  }

  const backupScheduleAction = async (schedule: BackupSchedule, action: 'toggle' | 'run' | 'delete') => {
    if (backupScheduleBusy) return
    if (action === 'delete' && !window.confirm(`Delete the ${schedule.database_name} backup schedule? Existing backup files will be kept.`)) return
    setBackupScheduleBusy(`${schedule.id}-${action}`)
    setError(null)
    try {
      const url = action === 'run'
        ? `/api/db/backups/schedules/${schedule.id}/run`
        : `/api/db/backups/schedules/${schedule.id}`
      const options = action === 'run'
        ? { method: 'POST' }
        : action === 'delete'
          ? { method: 'DELETE' }
          : { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !schedule.enabled }) }
      const res = await fetch(url, options)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Failed to ${action} backup schedule`)
      if (action === 'run') setBackupNotice(`Backup started for ${schedule.database_name}`)
      await loadBackups()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup schedule action failed')
    } finally {
      setBackupScheduleBusy(null)
    }
  }

  const handleCreateBackup = async () => {
    const database = backupDbChoice || selectedDb
    if (!database || creatingBackup) return
    setCreatingBackup(true)
    setBackupNotice(null)
    setError(null)
    try {
      const res = await fetch('/api/db/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Backup failed')
      setBackupNotice(`Backed up ${database} (${formatBytes(body.size_bytes)})`)
      await loadBackups()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed')
    } finally {
      setCreatingBackup(false)
      setTimeout(() => setBackupNotice(null), 6000)
    }
  }

  const handleRestore = async () => {
    if (!restoreFile || !restoreTarget.trim() || restoring) return
    setRestoring(true)
    setError(null)
    try {
      const res = await fetch('/api/db/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: restoreFile, targetDb: restoreTarget.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Restore failed')
      setBackupNotice(`Restored into new database "${body.database}"`)
      setRestoreFile(null)
      setRestoreTarget('')
      await loadDatabases()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed')
    } finally {
      setRestoring(false)
      setTimeout(() => setBackupNotice(null), 6000)
    }
  }

  const handleDeleteBackup = async (file: string) => {
    if (!window.confirm(`Delete backup ${file}? This cannot be undone.`)) return
    setDeletingBackup(file)
    setError(null)
    try {
      const res = await fetch('/api/db/backups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to delete backup')
      }
      await loadBackups()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete backup')
    } finally {
      setDeletingBackup(null)
    }
  }

  const totalPages = rowsResult ? Math.max(1, Math.ceil(rowsResult.total / rowsResult.pageSize)) : 1

  if (userLoaded && user?.role !== 'admin') {
    return (
      <AppShell title="Database" subtitle="Postgres server explorer" user={{ name: user?.name, role: user?.role }}>
        <Card className="mx-auto max-w-md text-center">
          <CardHeader>
            <Lock className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <CardTitle>Admins only</CardTitle>
            <CardDescription>Direct database access is restricted to administrator accounts.</CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    )
  }

  return (
    <AppShell
      title="Database"
      subtitle="Browse and query every Postgres database on this server."
      user={{ name: user?.name, role: user?.role }}
      actions={
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link href="/postgres" target="_blank">Open SQL client</Link></Button>
          <button
            onClick={() => void loadDatabases()}
            className="flex items-center gap-2 rounded-md bg-primary/10 px-4 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Left rail: databases + tables */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <HardDrive className="h-4 w-4 text-primary" />
                Databases
                <button
                  onClick={() => { setShowCreate(!showCreate); setCreatedCreds(null) }}
                  className="ml-auto flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                >
                  <Plus className="h-3 w-3" />
                  New
                </button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 px-3 pb-3">
              {showCreate && (
                <div className="mb-3 space-y-3 rounded-lg border border-primary/15 bg-primary/5 p-3">
                  <input
                    className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-zinc-600 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
                    placeholder="database_name"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateDatabase() }}
                    spellCheck={false}
                  />
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={createWithOwner}
                      onChange={(e) => setCreateWithOwner(e.target.checked)}
                      className="accent-sky-500"
                    />
                    Create a dedicated user as owner
                  </label>
                  {createWithOwner && (
                    <input
                      className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-zinc-600 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
                      placeholder={createName.trim() ? `${createName.trim()}_user` : 'username (optional)'}
                      value={createOwnerName}
                      onChange={(e) => setCreateOwnerName(e.target.value)}
                      spellCheck={false}
                    />
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowCreate(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={() => void handleCreateDatabase()} disabled={creating || !createName.trim()}>
                      {creating ? 'Creating…' : 'Create'}
                    </Button>
                  </div>
                </div>
              )}

              {createdCreds && (
                <div className="mb-3 space-y-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                    <KeyRound className="h-3.5 w-3.5" />
                    {createdCreds.database} created
                  </div>
                  {createdCreds.username ? (
                    <>
                      <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
                        <p>user: <span className="text-foreground">{createdCreds.username}</span></p>
                        <p className="break-all">pass: <span className="text-foreground">{createdCreds.password}</span></p>
                      </div>
                      <p className="text-[10px] text-amber-400/80">Save these now — the password is not stored anywhere.</p>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Owned by the postgres superuser.</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void handleCopyCreds()}>
                      {credsCopied ? <Check className="mr-1 h-3 w-3 text-emerald-400" /> : <Copy className="mr-1 h-3 w-3" />}
                      {credsCopied ? 'Copied' : 'Copy'}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCreatedCreds(null)}>
                      Done
                    </Button>
                  </div>
                </div>
              )}

              {databases.map((db) => {
                const projectDatabase = projectDatabases.find((item) => item.database_name === db.name)
                return (
                <div key={db.name} className="group relative">
                  <button
                    onClick={() => void selectDatabase(db.name)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-all ${
                      selectedDb === db.name
                        ? 'border border-primary/20 bg-primary/10 text-primary'
                        : 'border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
                    }`}
                  >
                    <span className="min-w-0">
                    <span className="flex items-center gap-2 truncate font-medium">
                      <Database className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{db.name}</span>
                    </span>
                    {projectDatabase && <span className="mt-0.5 block truncate pl-5 text-[10px] text-muted-foreground">{projectDatabase.project_name} · {projectDatabase.environment}</span>}
                    </span>
                    <span className="ml-2 flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                      {db.connections > 0 && (
                        <span className="flex items-center gap-0.5 text-emerald-400"><Users className="h-3 w-3" />{db.connections}</span>
                      )}
                      {db.size_pretty}
                    </span>
                  </button>
                  {!protectedDbs.includes(db.name) && !projectDatabase && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDropTarget(db.name); setDropConfirm('') }}
                      title={`Drop ${db.name}`}
                      className="absolute -right-1 top-1/2 -translate-y-1/2 rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )})}
              {databases.length === 0 && (
                <p className="px-3 py-4 text-center text-xs italic text-muted-foreground">Loading databases…</p>
              )}

              {dropTarget && (
                <div className="mt-3 space-y-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3">
                  <p className="text-xs font-semibold text-red-400">Drop {dropTarget}?</p>
                  <p className="text-[11px] text-muted-foreground">
                    This permanently deletes the database and terminates its connections. Type the name to confirm.
                  </p>
                  <input
                    className="w-full rounded-md border border-red-500/30 bg-black/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-zinc-600 focus:border-red-500/60 focus:outline-none focus:ring-1 focus:ring-red-500/50"
                    placeholder={dropTarget}
                    value={dropConfirm}
                    onChange={(e) => setDropConfirm(e.target.value)}
                    spellCheck={false}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setDropTarget(null); setDropConfirm('') }}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive" size="sm" className="h-7 text-xs"
                      disabled={dropConfirm !== dropTarget || dropping}
                      onClick={() => void handleDropDatabase()}
                    >
                      {dropping ? 'Dropping…' : 'Drop database'}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {selectedDb && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Table2 className="h-4 w-4 text-primary" />
                  Tables
                  <span className="ml-auto text-[10px] font-normal text-muted-foreground">{tables.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="max-h-[420px] space-y-1 overflow-y-auto px-3 pb-3">
                {tablesLoading ? (
                  <p className="px-3 py-4 text-center text-xs italic text-muted-foreground">Loading…</p>
                ) : tables.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs italic text-muted-foreground">No tables</p>
                ) : (
                  tables.map((t) => (
                    <button
                      key={`${t.schema}.${t.name}`}
                      onClick={() => selectTable(t.schema, t.name)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left font-mono text-xs transition-all ${
                        selectedTable?.schema === t.schema && selectedTable?.name === t.name
                          ? 'border border-primary/20 bg-primary/10 text-primary'
                          : 'border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
                      }`}
                    >
                      <span className="truncate">{t.schema !== 'public' ? `${t.schema}.` : ''}{t.name}</span>
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                        {t.est_rows > 0 ? `~${Number(t.est_rows).toLocaleString()}` : ''} · {t.size_pretty}
                      </span>
                    </button>
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Main: browse / SQL */}
        <div className="min-w-0">
          {!selectedDb ? (
            <Card className="flex h-[400px] items-center justify-center">
              <div className="text-center text-muted-foreground">
                <Database className="mx-auto mb-3 h-10 w-10 opacity-20" />
                <p className="text-sm">Select a database to explore its tables or run SQL.</p>
              </div>
            </Card>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="space-y-4">
              <TabsList className="border border-white/[0.08] bg-transparent">
                <TabsTrigger value="browse">Browse Data</TabsTrigger>
                <TabsTrigger value="sql">SQL Console</TabsTrigger>
              </TabsList>

              <TabsContent value="browse">
                <Card>
                  <CardHeader className="pb-4">
                    <CardTitle className="font-mono text-base">
                      {selectedTable ? `${selectedTable.schema}.${selectedTable.name}` : 'No table selected'}
                    </CardTitle>
                    {rowsResult && (
                      <CardDescription>
                        {rowsResult.total.toLocaleString()} rows · page {rowsResult.page} of {totalPages}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!selectedTable ? (
                      <p className="py-12 text-center text-sm italic text-muted-foreground">
                        Pick a table from the left to browse its rows.
                      </p>
                    ) : rowsLoading ? (
                      <div className="flex items-center justify-center py-12 text-muted-foreground">
                        <RefreshCw className="h-5 w-5 animate-spin" />
                      </div>
                    ) : rowsResult ? (
                      <>
                        <ResultsGrid columns={rowsResult.columns} rows={rowsResult.rows} />
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            Showing {rowsResult.rows.length} of {rowsResult.total.toLocaleString()} rows
                          </p>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline" size="sm"
                              disabled={rowsResult.page <= 1}
                              onClick={() => selectedDb && selectedTable && void loadRows(selectedDb, selectedTable.schema, selectedTable.name, rowsResult.page - 1)}
                            >
                              <ChevronLeft className="h-3.5 w-3.5" /> Prev
                            </Button>
                            <Button
                              variant="outline" size="sm"
                              disabled={rowsResult.page >= totalPages}
                              onClick={() => selectedDb && selectedTable && void loadRows(selectedDb, selectedTable.schema, selectedTable.name, rowsResult.page + 1)}
                            >
                              Next <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="sql">
                <Card>
                  <CardHeader className="pb-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">SQL Console</CardTitle>
                        <CardDescription>
                          Runs against <code className="rounded bg-white/[0.08] px-1 font-mono">{selectedDb}</code> · Ctrl+Enter to execute
                        </CardDescription>
                      </div>
                      <button
                        onClick={() => setAllowWrites(!allowWrites)}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                          allowWrites
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                            : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-400'
                        }`}
                        title={allowWrites ? 'Writes are enabled — queries can modify data' : 'Read-only: writes are blocked at the transaction level'}
                      >
                        {allowWrites ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                        {allowWrites ? 'Writes enabled' : 'Read-only'}
                      </button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <textarea
                      className="h-40 w-full resize-y rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs text-foreground placeholder:text-zinc-600 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/60"
                      value={sql}
                      onChange={(e) => setSql(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          void runSql()
                        }
                      }}
                      placeholder={'select * from users limit 10;'}
                      spellCheck={false}
                    />
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        {sqlResult && (
                          <span>
                            <span className="font-semibold text-emerald-400">{sqlResult.command}</span>
                            {' · '}{sqlResult.rowCount.toLocaleString()} rows · {sqlResult.durationMs}ms
                            {sqlResult.truncated && <span className="text-amber-400"> · truncated to 1,000 rows</span>}
                          </span>
                        )}
                      </div>
                      <Button size="sm" onClick={() => void runSql()} disabled={sqlRunning || !sql.trim()}>
                        {sqlRunning ? <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                        {sqlRunning ? 'Running…' : 'Run Query'}
                      </Button>
                    </div>

                    {sqlError && (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 font-mono text-xs text-red-400">
                        {sqlError}
                      </div>
                    )}

                    {sqlResult && sqlResult.columns.length > 0 && (
                      <div className="max-h-[480px] overflow-auto">
                        <ResultsGrid columns={sqlResult.columns} rows={sqlResult.rows} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>

      {/* Backups */}
      <Card className="mt-6">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="h-4 w-4 text-primary" />
                Backups
              </CardTitle>
              <CardDescription>
                Automated pg_dump schedules and restorable archives. Restores always create a new database.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="h-8" onClick={() => openBackupSchedule('new')}>
                <CalendarClock className="mr-2 h-3.5 w-3.5" />Schedule
              </Button>
              <select
                className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs text-foreground focus:border-primary/40 focus:outline-none"
                value={backupDbChoice}
                onChange={(e) => setBackupDbChoice(e.target.value)}
              >
                <option value="">{selectedDb ? `${selectedDb} (selected)` : 'Choose database…'}</option>
                {databases.map((db) => (
                  <option key={db.name} value={db.name}>{db.name}</option>
                ))}
              </select>
              <Button size="sm" className="h-8" onClick={() => void handleCreateBackup()} disabled={creatingBackup || (!backupDbChoice && !selectedDb)}>
                {creatingBackup ? <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Archive className="mr-2 h-3.5 w-3.5" />}
                {creatingBackup ? 'Backing up…' : 'Back up now'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {backupNotice && (
            <div className="mb-4 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-400">
              {backupNotice}
            </div>
          )}
          <div className="mb-6 border-b border-border pb-6">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Automatic schedules</p>
                <p className="text-xs text-muted-foreground">One daily, weekly, monthly, or yearly schedule per database.</p>
              </div>
              <span className="text-xs text-muted-foreground">{backupSchedules.filter((schedule) => schedule.enabled).length} enabled</span>
            </div>
            {backupSchedules.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No automatic backup schedules.</div>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {backupSchedules.map((schedule) => (
                  <div key={schedule.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-mono text-sm font-medium">{schedule.database_name}</p>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${schedule.last_status === 'success' ? 'bg-emerald-500/10 text-emerald-400' : schedule.last_status === 'failed' ? 'bg-red-500/10 text-red-400' : schedule.last_status === 'running' ? 'bg-sky-500/10 text-sky-400' : 'bg-secondary text-muted-foreground'}`}>{schedule.last_status}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{backupScheduleLabel(schedule)} · {schedule.timezone}</p>
                    </div>
                    <div className="text-xs">
                      <p className="text-[10px] uppercase text-muted-foreground">Next backup</p>
                      <p className="mt-1">{schedule.enabled && schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : 'Paused'}</p>
                    </div>
                    <div className="text-xs">
                      <p className="text-[10px] uppercase text-muted-foreground">Retention</p>
                      <p className="mt-1">Latest {schedule.retention_count} backups</p>
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Switch checked={schedule.enabled} onCheckedChange={() => void backupScheduleAction(schedule, 'toggle')} disabled={!!backupScheduleBusy || schedule.last_status === 'running'} aria-label={`Automatic backups for ${schedule.database_name}`} />
                      <button type="button" title="Run backup now" aria-label="Run backup now" onClick={() => void backupScheduleAction(schedule, 'run')} disabled={!!backupScheduleBusy || schedule.last_status === 'running'} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"><Play className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Edit schedule" aria-label="Edit schedule" onClick={() => openBackupSchedule(schedule)} disabled={schedule.last_status === 'running'} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"><Pencil className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Delete schedule" aria-label="Delete schedule" onClick={() => void backupScheduleAction(schedule, 'delete')} disabled={!!backupScheduleBusy || schedule.last_status === 'running'} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-red-400 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    {schedule.last_error && <p className="text-xs text-red-400 md:col-span-4">{schedule.last_error}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {backups.length === 0 ? (
            <p className="py-8 text-center text-sm italic text-muted-foreground">
              No backup archives yet. Create one above or wait for an automatic schedule.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/[0.08]">
              <table className="w-full min-w-max text-left text-xs">
                <thead className="bg-white/[0.03]">
                  <tr className="text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Database</th>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Size</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {backups.map((b) => (
                    <tr key={b.file} className="transition-colors hover:bg-white/[0.02]">
                      <td className="px-3 py-2 font-mono font-medium text-foreground">{b.database}</td>
                      <td className="px-3 py-2 font-mono text-muted-foreground">{b.file}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatBytes(b.size_bytes)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{new Date(b.created_at).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <a
                            href={`/api/db/backups/download?file=${encodeURIComponent(b.file)}`}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          <button
                            onClick={() => { setRestoreFile(restoreFile === b.file ? null : b.file); setRestoreTarget(`${b.database}_restored`) }}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-sky-400"
                            title="Restore into a new database"
                          >
                            <History className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => void handleDeleteBackup(b.file)}
                            disabled={deletingBackup === b.file}
                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-red-400 disabled:opacity-50"
                            title="Delete backup"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {restoreFile && (
            <div className="mt-4 space-y-2 rounded-lg border border-sky-500/25 bg-sky-500/5 p-4">
              <p className="text-xs font-semibold text-sky-400">Restore {restoreFile}</p>
              <p className="text-[11px] text-muted-foreground">
                The backup is restored into a brand-new database — existing databases are never overwritten.
              </p>
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-zinc-600 focus:border-sky-500/40 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                  placeholder="new_database_name"
                  value={restoreTarget}
                  onChange={(e) => setRestoreTarget(e.target.value)}
                  spellCheck={false}
                />
                <Button variant="ghost" size="sm" onClick={() => { setRestoreFile(null); setRestoreTarget('') }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void handleRestore()} disabled={restoring || !restoreTarget.trim()}>
                  {restoring ? 'Restoring…' : 'Restore'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={backupScheduleEditor !== null} onOpenChange={(open) => !open && setBackupScheduleEditor(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{backupScheduleEditor === 'new' ? 'Schedule database backup' : 'Edit backup schedule'}</SheetTitle>
            <SheetDescription>Configure an automatic pg_dump schedule for one database.</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-5">
            <label className="grid gap-2 text-sm font-medium">
              Database
              <select value={backupScheduleForm.database} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, database: event.target.value })} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring">
                <option value="">Select database</option>
                {databases.map((database) => <option key={database.name} value={database.name}>{database.name}</option>)}
              </select>
            </label>

            <div className="grid gap-2">
              <label className="text-sm font-medium">Frequency</label>
              <div className="grid grid-cols-4 rounded-md border border-border bg-muted p-1">
                {(['daily', 'weekly', 'monthly', 'yearly'] as BackupFrequency[]).map((frequency) => (
                  <button
                    key={frequency}
                    type="button"
                    aria-pressed={backupScheduleForm.frequency === frequency}
                    onClick={() => setBackupScheduleForm({ ...backupScheduleForm, frequency })}
                    className={`h-8 rounded px-2 text-xs font-medium capitalize transition-colors ${backupScheduleForm.frequency === frequency ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {frequency}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">Run time<input type="time" value={backupScheduleForm.timeOfDay} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, timeOfDay: event.target.value })} className="h-10 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring" /></label>
              <label className="grid gap-2 text-sm font-medium">Timezone<select value={backupScheduleForm.timezone} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, timezone: event.target.value })} className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring">{backupTimezones.map((timezone) => <option key={timezone}>{timezone}</option>)}</select></label>
            </div>

            {backupScheduleForm.frequency === 'weekly' && (
              <label className="grid gap-2 text-sm font-medium">Weekday<select value={backupScheduleForm.dayOfWeek} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, dayOfWeek: Number(event.target.value) })} className="h-10 rounded-md border border-input bg-background px-3 text-sm">{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
            )}
            {(backupScheduleForm.frequency === 'monthly' || backupScheduleForm.frequency === 'yearly') && (
              <label className="grid gap-2 text-sm font-medium">Day of month<select value={backupScheduleForm.dayOfMonth} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, dayOfMonth: Number(event.target.value) })} className="h-10 rounded-md border border-input bg-background px-3 text-sm">{Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day}>{day}</option>)}</select></label>
            )}
            {backupScheduleForm.frequency === 'yearly' && (
              <label className="grid gap-2 text-sm font-medium">Month<select value={backupScheduleForm.monthOfYear} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, monthOfYear: Number(event.target.value) })} className="h-10 rounded-md border border-input bg-background px-3 text-sm">{months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
            )}

            <label className="grid gap-2 text-sm font-medium">Retention count<input type="number" min={1} max={365} value={backupScheduleForm.retentionCount} onChange={(event) => setBackupScheduleForm({ ...backupScheduleForm, retentionCount: Number(event.target.value) })} className="h-10 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:ring-1 focus:ring-ring" /><span className="text-xs font-normal text-muted-foreground">Older archives for this database are removed after the latest count is exceeded.</span></label>

            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div><p className="text-sm font-medium">Automatic backups</p><p className="text-xs text-muted-foreground">Calculate the next run and execute this schedule.</p></div>
              <Switch checked={backupScheduleForm.enabled} onCheckedChange={(enabled) => setBackupScheduleForm({ ...backupScheduleForm, enabled })} aria-label="Automatic backups" />
            </div>

            <Button className="w-full" onClick={() => void saveBackupSchedule()} disabled={backupScheduleBusy === 'save' || !backupScheduleForm.database}>
              {backupScheduleBusy === 'save' ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save backup schedule
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  )
}
