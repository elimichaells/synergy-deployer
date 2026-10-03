'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowUpRight, Check, Copy, Database, Eye, HardDriveDownload, Layers, Loader2, Lock, Play, RotateCcw, ShieldCheck, AlertTriangle, Truck } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DataRemovalAction } from '@/components/data-removal-action'
import { Section } from '@/components/app/section'
import { ProviderLogo, providerMeta, type Provider } from '@/components/app/providers'
import { Flag, serverRoleLabel } from '@/components/storage/bits'
import { DedicatedUserSheet } from '@/components/storage/dedicated-user-sheet'
import { MoveDatabaseSheet } from '@/components/storage/move-database-sheet'
import { DataTab } from '@/components/storage/data-tab'
import { SqlTab } from '@/components/storage/sql-tab'
import { ScheduleSheet, type ScheduleValues } from '@/components/storage/schedule-sheet'
import { ControlBackupsPanel } from '@/components/storage/control-backups-panel'
import { relativeTime } from '@/lib/deployment-stages'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

interface App { serviceId: string; projectId: string; name: string; environment: string; groupId: string | null; groupName: string | null; ownership: string; username: string | null }
interface Detail {
  id: string; database: string; engine: Provider; serverId: string; serverName: string; serverRole: 'system' | 'apps' | 'external'; host: string; port: number
  sizeBytes: number | null; tableCount: number | null; ownership: string; apps: App[]; warnings: string[]
  backup: (ScheduleValues & { scheduleId: string; lastStatus: string; lastFinishedAt: string | null; nextRunAt: string | null; legacy?: boolean }) | null
  backups: { file: string; serviceId: string; sizeBytes: number; createdAt: string }[]
}
interface Engine { id: string; listen: string | null; localOnly: boolean | null; remoteRules: number | null; ssl: boolean | null; pendingRestart: boolean }

const TABS = ['overview', 'data', 'sql', 'backups', 'connect', 'settings'] as const
const TAB_LABELS: Record<string, string> = { overview: 'Overview', data: 'Data', sql: 'SQL', backups: 'Backups', connect: 'Connection', settings: 'Settings' }
const ownershipLabel: Record<string, string> = { manager: 'Created by Synergy', shared: 'Shared in its project', adopted: 'Configured in the app\'s .env', external: 'Connected existing database' }

export default function DatabasePage() {
  const { id } = useParams<{ id: string }>()
  const [database, setDatabase] = useState<Detail | null>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [access, setAccess] = useState({ isAdmin: false, canWrite: false })
  const [tab, setTab] = useState<string>('overview')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [dedicatedOpen, setDedicatedOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const response = await fetch(`/api/storage/${id}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not load the database')
    setDatabase(body.database); setAccess({ isAdmin: body.isAdmin, canWrite: body.canWrite }); setNow(Date.now())
    const engines = await fetch('/api/storage/engines', { cache: 'no-store' }).then(res => res.ok ? res.json() : null).catch(() => null)
    setEngine(engines?.engines?.find((item: Engine) => item.id === body.database.serverId) || null)
  }, [id])

  useEffect(() => { void load().catch(err => setError(err.message)) }, [load])
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('tab')
    if (TABS.includes(value as typeof TABS[number])) setTab(value!)
  }, [])

  const act = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key); setError(''); setNotice('')
    try { const message = await action(); if (message) setNotice(message); await load() }
    catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const reveal = () => act('reveal', async () => {
    const response = await fetch(`/api/storage/${id}/reveal`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not reveal the connection')
    setRevealed(body.url)
  })

  const enableBackups = () => act('schedule', async () => {
    const response = await fetch('/api/data/backups/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      serviceId: database!.id, enabled: true, frequency: 'daily', timeOfDay: '03:00', timezone: 'UTC', dayOfWeek: 0, dayOfMonth: 1, monthOfYear: 1, retentionCount: 30,
    }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Backups could not be turned on')
    return 'Daily backups are on (03:00 UTC, 30 kept).'
  })

  const backupNow = () => act('backup', async () => {
    const response = await fetch(`/api/data/backups/schedules/${database!.backup!.scheduleId}/run`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'The backup could not start')
    return 'Backup started. It appears in the list when it finishes; large databases take a few minutes.'
  })

  const restore = (file: string) => act(`restore-${file}`, async () => {
    if (!window.confirm(`Restore ${file} into a NEW database on the same server? Nothing that is running changes; you can point the app at the new database after checking it.`)) return
    const response = await fetch(`/api/storage/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Restore failed')
    return `Restored into the new database ${body.database}.${body.warnings ? ' Some objects reported warnings (for example extensions that need a superuser); check the data before using it.' : ''}`
  })

  if (!database) {
    return <AppShell title={error ? 'Database not found' : 'Loading database…'} back={{ href: '/storage', label: 'Storage' }}>
      {error ? <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">{error}</div> : <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />}
    </AppShell>
  }

  const owner = database.apps.find(app => app.serviceId === database.id) || database.apps[0]
  const isPostgres = database.engine === 'postgresql'
  const browserUrl = isPostgres ? `/postgres/connect/svc-${database.id}` : ['mysql', 'mariadb'].includes(database.engine) ? '/mysql/' : null
  const role = serverRoleLabel[database.serverRole]
  const recommendations: { title: string; body: string; action?: React.ReactNode }[] = []
  if (database.serverRole === 'system') recommendations.push(isPostgres
    ? { title: 'Move it off Synergy\'s own server', body: 'This database lives on the same PostgreSQL server as Synergy\'s control database, so a problem in one affects the other. Moving it makes an exact copy on the apps server with its own login, then switches the app over; its apps are stopped for a few minutes.', action: <Button size="sm" onClick={() => setMoveOpen(true)}><Truck className="mr-1.5 h-3.5 w-3.5" />Plan the move</Button> }
    : { title: 'Move it off Synergy\'s own server', body: 'This database lives on the same server as Synergy\'s control database. A problem in one affects the other.', action: <Button asChild size="sm" variant="outline"><Link href={`/sites/${owner.projectId}?tab=storage`}>Open the app&apos;s storage</Link></Button> })
  // Moving also gives the database its own login, so this only matters where it stays put.
  if (database.serverRole !== 'system' && database.warnings.some(warning => warning.includes('superuser'))) recommendations.push({ title: 'Stop using a superuser account', body: 'The app signs in as a superuser, which can read and change every database on the server, including Synergy\'s, and run commands on the machine. Give it a user that can only reach this database; the data stays where it is.', action: <Button size="sm" onClick={() => setDedicatedOpen(true)} disabled={!access.isAdmin}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Give it a dedicated user</Button> })
  if (database.warnings.some(warning => warning.includes('Staging'))) recommendations.push({ title: 'Give staging its own database', body: 'Testing on staging currently changes production data. Add a separate database to the staging app and copy production data into it when you need realistic data.' })
  if (!database.backup && isPostgres && database.serverRole !== 'external') recommendations.push({ title: 'Turn on backups', body: 'Nothing is backing this database up yet.', action: <Button size="sm" onClick={() => void enableBackups()} disabled={!access.isAdmin || busy !== null}>{busy === 'schedule' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />}Turn on daily backups</Button> })

  const canBrowse = isPostgres && database.serverRole !== 'external' && access.isAdmin
  const visibleTabs = TABS.filter(value => canBrowse || (value !== 'data' && value !== 'sql'))
  const tabs = (
    <TabsList className="scrollbar-none h-auto min-h-0 w-full justify-start gap-0 overflow-x-auto border-0 bg-transparent p-0">
      {visibleTabs.map(value => (
        <TabsTrigger key={value} value={value} className="group relative min-h-0 rounded-none border-0 px-1 pb-3 pt-1 text-[13px] font-normal text-muted-foreground data-[state=active]:text-foreground">
          <span className="rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">{TAB_LABELS[value]}</span>
          <span className="absolute inset-x-2 bottom-0 hidden h-[2px] rounded-full bg-foreground group-data-[state=active]:block" aria-hidden="true" />
        </TabsTrigger>
      ))}
    </TabsList>
  )

  return (
    <Tabs value={tab} onValueChange={value => { setTab(value); window.history.replaceState(null, '', `?tab=${value}`) }}>
      <AppShell
        title={database.database}
        back={{ href: '/storage', label: 'Storage' }}
        subtitle={<span className="flex flex-wrap items-center gap-2"><ProviderLogo provider={database.engine} size="sm" />{providerMeta[database.engine]?.label} · {formatBytes(database.sizeBytes)}<span className={cn('rounded-full border px-2 py-px text-[11px]', role.className)}>{role.label}</span></span>}
        tabs={tabs}
        actions={browserUrl && !isPostgres && database.serverRole !== 'external' ? <Button asChild variant="outline" size="sm" disabled={!access.isAdmin}><a href={browserUrl} target="_blank" rel="noreferrer"><Database className="mr-1.5 h-3.5 w-3.5" />Open in phpMyAdmin<ArrowUpRight className="ml-1 h-3.5 w-3.5" /></a></Button> : undefined}
      >
        {error && <div role="alert" className="notice-error">{error}</div>}
        {notice && <p role="status" className="mb-5 rounded-md border border-status-ready/25 bg-status-ready/5 px-4 py-3 text-sm text-emerald-200">{notice}</p>}

        <TabsContent value="overview" className="mt-0 space-y-6">
          {recommendations.length > 0 && (
            <Section title={<span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-status-building" />Needs attention</span>} description="What's risky about this database today, and how to fix it.">
              <div className="space-y-3">
                {recommendations.map(item => (
                  <div key={item.title} className="flex flex-wrap items-start gap-3 rounded-lg border border-border p-4">
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</p></div>
                    {item.action}
                  </div>
                ))}
              </div>
            </Section>
          )}
          <Section title="Details">
            <dl className="summary-list">
              <div><dt>Engine</dt><dd>{providerMeta[database.engine]?.label}</dd></div>
              <div><dt>Server</dt><dd>{database.serverName} <span className="font-mono text-xs text-muted-foreground">{database.host}:{database.port}</span></dd></div>
              <div><dt>Size</dt><dd>{formatBytes(database.sizeBytes)}{database.tableCount !== null && <span className="text-muted-foreground"> · {database.tableCount} tables</span>}</dd></div>
              <div><dt>Backups</dt><dd>{database.backup ? `${database.backup.frequency}${database.backup.lastFinishedAt ? `, last ${relativeTime(database.backup.lastFinishedAt, now)} (${database.backup.lastStatus})` : ', not run yet'}` : isPostgres ? 'Not scheduled' : 'Handled by the database server'}</dd></div>
              <div><dt>How Synergy knows it</dt><dd>{ownershipLabel[database.ownership] || database.ownership}</dd></div>
            </dl>
          </Section>
          <Section title="Used by" description="Apps that read and write this database.">
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {database.apps.map(app => (
                <div key={app.serviceId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <Link href={`/sites/${app.projectId}?tab=storage`} className="font-medium hover:underline">{app.name}</Link>
                  <span className="text-xs capitalize text-muted-foreground">{app.environment}</span>
                  {app.groupName && <Link href={`/projects/${app.groupId}?tab=storage`} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><Layers className="h-3 w-3" />{app.groupName}</Link>}
                  <span className="ml-auto text-xs text-muted-foreground">{ownershipLabel[app.ownership] || app.ownership}{app.username ? ` · user ${app.username}` : ''}</span>
                </div>
              ))}
            </div>
          </Section>
        </TabsContent>

        {canBrowse && <TabsContent value="data" className="mt-0"><DataTab serviceId={database.id} /></TabsContent>}
        {canBrowse && <TabsContent value="sql" className="mt-0"><SqlTab serviceId={database.id} database={database.database} /></TabsContent>}

        <TabsContent value="connect" className="mt-0 space-y-6">
          <Section title="Connection details" description={database.ownership === 'adopted' ? 'The app reads these from its own environment file. Synergy shows them here; it never changes them.' : 'Synergy gives these to the app as environment variables at every deployment.'}
            footer={access.isAdmin ? <><span>Revealing the password is recorded in the audit log.</span><Button size="sm" variant="outline" onClick={() => void reveal()} disabled={busy !== null}>{busy === 'reveal' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}Reveal connection string</Button></> : <span>Only administrators can reveal the password.</span>}>
            <dl className="summary-list">
              <div><dt>Host</dt><dd className="font-mono text-xs">{database.host}</dd></div>
              <div><dt>Port</dt><dd className="font-mono text-xs">{database.port}</dd></div>
              <div><dt>Database</dt><dd className="font-mono text-xs">{database.database}</dd></div>
              <div><dt>User</dt><dd className="font-mono text-xs">{owner.username || '—'}</dd></div>
              <div><dt>Password</dt><dd className="font-mono text-xs">••••••••••••</dd></div>
            </dl>
            {revealed && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-black p-3">
                <code className="min-w-0 flex-1 break-all text-xs">{revealed}</code>
                <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" aria-label="Copy connection string" onClick={async () => { await navigator.clipboard.writeText(revealed); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button>
              </div>
            )}
          </Section>
          <Section title={<span className="flex items-center gap-2"><Lock className="h-4 w-4" />Access from other machines</span>} description="By default databases accept connections from apps on this server only. That is the safest setup.">
            {database.serverRole === 'external' ? <p className="text-sm text-muted-foreground">This database is hosted elsewhere; access is controlled by its provider.</p> : (
              <div className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  {engine ? <>
                    <Flag tone={engine.localOnly ? 'info' : 'warn'}>{engine.localOnly ? 'This machine only' : `Listening on ${engine.listen || 'all interfaces'}`}{engine.pendingRestart ? ' (change pending restart)' : ''}</Flag>
                    <Flag tone={engine.remoteRules ? 'warn' : 'info'}>{engine.remoteRules === null ? 'Remote sign-in rules unknown' : engine.remoteRules ? `${engine.remoteRules} remote sign-in rule(s)` : 'No remote sign-ins allowed'}</Flag>
                    <Flag tone={engine.ssl ? 'info' : 'warn'}>{engine.ssl ? 'TLS available' : 'TLS off'}</Flag>
                  </> : <span className="text-xs text-muted-foreground">Server status is visible to operators and administrators.</span>}
                </div>
                <div className="rounded-lg border border-border p-4">
                  <p className="font-medium">Recommended: connect through a tunnel</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">Keep the database private and reach it from your computer through an encrypted tunnel instead of opening its port. With OpenSSH Server enabled on this machine:</p>
                  <code className="mt-2 block rounded-md border border-border bg-black px-3 py-2 text-xs">ssh -L 15432:127.0.0.1:{database.port} Administrator@your-server</code>
                  <p className="mt-2 text-xs text-muted-foreground">Then connect your database tool to <span className="font-mono text-foreground">127.0.0.1:15432</span>. A private network such as Tailscale or WireGuard works the same way. Server-wide network settings are in <Link href="/storage?tab=servers" className="text-foreground underline-offset-4 hover:underline">Storage &gt; Servers</Link>.</p>
                </div>
              </div>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="backups" className="mt-0 space-y-6">
          {!isPostgres ? (
            <Section title="Backups" description={`Synergy backs up PostgreSQL databases. Back up ${providerMeta[database.engine]?.label} databases with the server's own tools${database.engine === 'mysql' || database.engine === 'mariadb' ? ', for example phpMyAdmin\'s Export' : ''}.`} />
          ) : database.serverRole === 'external' ? (
            <Section title="Backups" description="This database is hosted elsewhere. Use its provider's backups." />
          ) : database.backup?.legacy ? (
            <ControlBackupsPanel database={database.database} isAdmin={access.isAdmin} />
          ) : (
            <>
              <Section title="Schedule" description="Backups are compressed PostgreSQL dumps stored on this server."
                action={database.backup
                  ? <Button size="sm" onClick={() => void backupNow()} disabled={!access.isAdmin || busy !== null || database.backup.lastStatus === 'running'}>{busy === 'backup' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}Back up now</Button>
                  : <Button size="sm" onClick={() => void enableBackups()} disabled={!access.isAdmin || busy !== null}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Turn on daily backups</Button>}
                footer={database.backup ? <><span>Backups are stored on this server and the oldest are deleted automatically.</span><Button size="sm" variant="outline" onClick={() => setScheduleOpen(true)} disabled={!access.isAdmin}>Edit schedule</Button></> : undefined}>
                {database.backup ? (
                  <dl className="summary-list">
                    <div><dt>Frequency</dt><dd className="capitalize">{database.backup.frequency}{database.backup.enabled ? '' : ' (paused)'}</dd></div>
                    <div><dt>Last backup</dt><dd>{database.backup.lastFinishedAt ? `${relativeTime(database.backup.lastFinishedAt, now)} · ${database.backup.lastStatus}` : database.backup.lastStatus === 'running' ? 'Running now' : 'Not run yet'}</dd></div>
                    <div><dt>Next backup</dt><dd>{database.backup.nextRunAt ? new Date(database.backup.nextRunAt).toLocaleString() : '—'}</dd></div>
                    <div><dt>Keeps</dt><dd>{database.backup.retentionCount} backups</dd></div>
                  </dl>
                ) : <p className="text-sm text-muted-foreground">No backups are scheduled for this database.</p>}
              </Section>
              <Section title="Backup files" description="Restoring creates a new database next to this one, so nothing running is affected. Check the data, then point the app at it.">
                {database.backups.length ? (
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                    {database.backups.map(backup => (
                      <div key={backup.serviceId + backup.file} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <HardDriveDownload className="h-4 w-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1"><span className="block truncate font-mono text-xs">{backup.file}</span><span className="block text-xs text-muted-foreground">{new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)}</span></span>
                        <Button size="sm" variant="outline" onClick={() => void restore(backup.file)} disabled={!access.isAdmin || busy !== null}>{busy === `restore-${backup.file}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}Restore to new database</Button>
                      </div>
                    ))}
                  </div>
                ) : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No backup files yet.</p>}
              </Section>
            </>
          )}
        </TabsContent>

        <TabsContent value="settings" className="mt-0 space-y-6">
          {isPostgres && database.serverRole !== 'external' && <Section title="Move to another server" description="Make an exact copy on another PostgreSQL server on this machine with its own login, check it, and switch the apps over. The original is kept until you remove it."
            action={<Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}><Truck className="mr-1.5 h-3.5 w-3.5" />Plan the move</Button>} />}
          <Section title="Copy data to another database" description="Move this database to another server or engine, for example from Synergy's system server to the apps server. The copy is checked table by table and nothing here is changed.">
            <Button asChild size="sm" variant="outline"><Link href={`/sites/${owner.projectId}?tab=storage`}>Open {owner.name}&apos;s storage to start</Link></Button>
          </Section>
          <Section title="Disconnect from apps" description="Stops Synergy tracking this database for an app. The database and all its data stay on the server, and an app configured through its .env keeps working.">
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {database.apps.map(app => (
                <div key={app.serviceId} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <span className="flex-1">{app.name} <span className="text-xs capitalize text-muted-foreground">· {app.environment}</span></span>
                  {access.isAdmin && <DataRemovalAction kind="resource" name={`${database.database} from ${app.name}`} endpoint={`/api/sites/${app.projectId}/data-services/${app.serviceId}`} blockedReason={null} onRemoved={async () => { window.location.href = '/storage' }} />}
                </div>
              ))}
            </div>
          </Section>
        </TabsContent>
      </AppShell>
      <ScheduleSheet target={{ kind: 'service', serviceId: database.id }} initial={database.backup} open={scheduleOpen} onOpenChange={setScheduleOpen} onSaved={() => void load().catch(() => undefined)} />
      {isPostgres && <MoveDatabaseSheet serviceId={database.id} open={moveOpen} onOpenChange={setMoveOpen} onDone={() => void load().catch(() => undefined)} />}
      <DedicatedUserSheet serviceId={database.id} open={dedicatedOpen} onOpenChange={setDedicatedOpen} onDone={() => { setRevealed(null); void load().catch(() => undefined) }} />
    </Tabs>
  )
}
