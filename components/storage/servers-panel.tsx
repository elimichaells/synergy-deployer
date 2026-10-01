'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, CheckCircle2, Database, Eye, Loader2, Play, Power, Server, StopCircle, Trash2, XCircle } from 'lucide-react'
import { DataRemovalAction } from '@/components/data-removal-action'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { ServiceCatalog } from '@/components/app/service-catalog'
import { EnginesPanel } from '@/components/storage/engines-panel'
import { ServerDatabases } from '@/components/storage/server-databases'

type Provider = 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver' | 'mongodb' | 'redis'
type ConnectionPurpose = 'shared_application' | 'dedicated_application' | 'external_service'
interface User { id: string; name: string; role: string }
interface Connection { id: string; name: string; provider: Provider; host: string; port: number; username: string | null; tls_enabled: boolean; last_status: string; last_error: string | null; service_count: number; purpose: ConnectionPurpose; managed: boolean; is_default: boolean; provisioning_enabled: boolean }
interface DataService { id: string; project_id: string; project_name: string; environment: string; connection_id: string; connection_name: string; provider: Provider; host: string; port: number; name: string; database_name: string; username: string | null; env_prefix: string; application_primary: boolean; removal_blocked_reason: string | null; options: { ownership?: 'manager' | 'external' | 'shared' } }
interface MigrationTable { sourceSchema: string; sourceTable: string; sourceObject: string; targetSchema: string; targetTable: string; targetObject: string; targetExists?: boolean }
interface MigrationPreview { source: { id: string; name: string; provider: Provider; database: string; projectId: string; projectName: string }; target: { id: string; name: string; provider: Provider; database: string }; tables: MigrationTable[]; existingTargetTables: number }
interface MigrationJob { id: string; project_id: string; project_name: string; source_service_id: string; source_service_name: string; source_provider: Provider; source_database: string; target_service_id: string; target_service_name: string; target_provider: Provider; target_database: string; status: 'queued' | 'running' | 'validating' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'activated'; preserve_schema: boolean; replace_target: boolean; table_map: MigrationTable[]; validation: Array<{ table: string; target: string; sourceRows: string; targetRows: string; match: boolean }> | null; log: string; error: string | null; created_at: string; finished_at: string | null; activated_at: string | null; removal_blocked_reason: string | null }

const providerLabels: Record<Provider, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis' }
const purposeLabels: Record<ConnectionPurpose, string> = { shared_application: 'Shared applications', dedicated_application: 'Dedicated application', external_service: 'External service' }
const defaultPorts: Record<Provider, number> = { postgresql: 5433, mysql: 3306, mariadb: 3306, sqlserver: 1433, mongodb: 27017, redis: 6379 }
const relationalProviders: Provider[] = ['postgresql', 'mysql', 'mariadb', 'sqlserver']
const activeMigrationStatuses = ['queued', 'running', 'validating']
const inputClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring'

/** Database servers and migrations, shown as the Servers and Migrations tabs of Storage. */
export function ServersAndMigrations({ view }: { view: 'servers' | 'migrations' }) {
  const [user, setUser] = useState<User | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [services, setServices] = useState<DataService[]>([])
  const [migrations, setMigrations] = useState<MigrationJob[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [migrationDetails, setMigrationDetails] = useState<MigrationJob | null>(null)
  const [migrationPreview, setMigrationPreview] = useState<MigrationPreview | null>(null)
  const [connectionForm, setConnectionForm] = useState({ name: '', provider: 'postgresql' as Provider, host: '127.0.0.1', port: 5433, username: '', password: '', tlsEnabled: false, purpose: 'shared_application' as ConnectionPurpose, isDefault: false, provisioningEnabled: true })
  const [migrationForm, setMigrationForm] = useState({ sourceServiceId: '', targetServiceId: '', preserveSchema: true, replaceTarget: false })

  const refresh = useCallback(async () => {
    setNotice(null)
    try {
      const [me, connectionResponse, serviceResponse, migrationResponse] = await Promise.all([
        fetch('/api/auth/me'), fetch('/api/data/connections'), fetch('/api/data/services'), fetch('/api/data/migrations'),
      ])
      if (!connectionResponse.ok || !serviceResponse.ok || !migrationResponse.ok) throw new Error('Failed to load data services')
      setUser((await me.json()).user || null)
      setConnections((await connectionResponse.json()).connections || [])
      setServices((await serviceResponse.json()).services || [])
      setMigrations((await migrationResponse.json()).migrations || [])
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Failed to load data services') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!migrations.some((migration) => activeMigrationStatuses.includes(migration.status))) return
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [migrations, refresh])
  const isAdmin = user?.role === 'admin'
  const migrationSource = useMemo(() => services.find((service) => service.id === migrationForm.sourceServiceId), [services, migrationForm.sourceServiceId])
  const migrationTargets = useMemo(() => services.filter((service) => service.id !== migrationSource?.id && service.project_id === migrationSource?.project_id && relationalProviders.includes(service.provider)), [services, migrationSource])

  const createConnection = async () => {
    setBusy('connection-create'); setNotice(null)
    try {
      const response = await fetch('/api/data/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connectionForm) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Connection failed')
      setConnectionOpen(false)
      setConnectionForm({ name: '', provider: 'postgresql', host: '127.0.0.1', port: 5433, username: '', password: '', tlsEnabled: false, purpose: 'shared_application', isDefault: false, provisioningEnabled: true })
      setNotice('Connection verified and saved.')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Connection failed') }
    finally { setBusy(null) }
  }

  const testConnection = async (id: string) => {
    setBusy(`test-${id}`); setNotice(null)
    try {
      const response = await fetch(`/api/data/connections/${id}/test`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Connection test failed')
      setNotice('Connection is healthy.')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Connection test failed'); await refresh() }
    finally { setBusy(null) }
  }

  const deleteConnection = async (connection: Connection) => {
    if (!window.confirm(`Remove connection "${connection.name}"?`)) return
    setBusy(`delete-connection-${connection.id}`)
    try {
      const response = await fetch(`/api/data/connections/${connection.id}`, { method: 'DELETE' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Unable to remove connection')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to remove connection') }
    finally { setBusy(null) }
  }

  const previewMigration = async () => {
    if (!migrationForm.sourceServiceId || !migrationForm.targetServiceId) return
    setBusy('migration-preview'); setNotice(null); setMigrationPreview(null)
    try {
      const response = await fetch('/api/data/migrations/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(migrationForm) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Migration preview failed')
      setMigrationPreview(body.preview)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Migration preview failed') }
    finally { setBusy(null) }
  }

  const startMigration = async () => {
    if (!migrationPreview) return
    setBusy('migration-start'); setNotice(null)
    try {
      const response = await fetch('/api/data/migrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...migrationForm, tables: migrationPreview.tables.map((table) => table.sourceObject) }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Migration could not start')
      setMigrationOpen(false); setMigrationPreview(null)
      setMigrationForm({ sourceServiceId: '', targetServiceId: '', preserveSchema: true, replaceTarget: false })
      setNotice('Database migration started. Source data remains unchanged.')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Migration could not start') }
    finally { setBusy(null) }
  }

  const cancelMigration = async (migration: MigrationJob) => {
    if (!window.confirm(`Cancel the migration from ${migration.source_database} to ${migration.target_database}?`)) return
    setBusy(`migration-cancel-${migration.id}`)
    try {
      const response = await fetch(`/api/data/migrations/${migration.id}/cancel`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Migration could not be cancelled')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Migration could not be cancelled') }
    finally { setBusy(null) }
  }

  const activateMigration = async (migration: MigrationJob) => {
    if (!window.confirm(`Activate ${migration.target_service_name} as ${migration.source_service_name}? Redeploy the project afterward to apply the new database environment.`)) return
    setBusy(`migration-activate-${migration.id}`)
    try {
      const response = await fetch(`/api/data/migrations/${migration.id}/activate`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Migration target could not be activated')
      setNotice('Migration target activated. Redeploy the project to apply the new database environment.')
      await refresh()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Migration target could not be activated') }
    finally { setBusy(null) }
  }

  return (
    <>
      <div className="space-y-6">
        {notice && <div className="rounded-md border border-border bg-muted/50 px-4 py-3 text-sm">{notice}</div>}
        {isAdmin && <div className="flex flex-wrap justify-end gap-2">
          {view === 'migrations' && <Button size="sm" variant="outline" onClick={() => { setMigrationOpen(true); setMigrationPreview(null) }} disabled={services.filter((service) => relationalProviders.includes(service.provider)).length < 2}><ArrowRightLeft className="mr-2 h-4 w-4" />Migrate data</Button>}
          {view === 'servers' && <Button size="sm" onClick={() => setCatalogOpen(true)}><Server className="mr-2 h-4 w-4" />Add database server</Button>}
        </div>}
        {view === 'servers' && <EnginesPanel renderActions={engine => {
          const connection = connections.find(item => item.id === engine.id)
          if (!connection || !isAdmin) return null
          return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted-foreground">{connection.service_count} project service{connection.service_count === 1 ? '' : 's'}{connection.tls_enabled ? ' · TLS' : ''}{!connection.provisioning_enabled ? ' · new databases disabled' : ''}</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => void testConnection(connection.id)} disabled={!!busy}>{busy === `test-${connection.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <><CheckCircle2 className="mr-2 h-4 w-4" />Test connection</>}</Button>
              <Button variant="ghost" size="sm" title={connection.managed ? 'Managed by the Windows installer' : connection.service_count > 0 ? 'Disconnect its databases from their apps first' : 'Remove this server connection'} onClick={() => void deleteConnection(connection)} disabled={!!busy || connection.service_count > 0 || connection.managed}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
        }} />}
        {view === 'servers' && <ServerDatabases servers={connections} isAdmin={isAdmin} />}
        {view === 'migrations' && <section>
          <div className="mb-3"><h2 className="text-sm font-semibold">Database migrations</h2><p className="text-xs text-muted-foreground">Validated transfers between project-owned relational services.</p></div>
          <div className="overflow-x-auto border-y border-border">
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Project</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Tables</th><th className="px-4 py-3">Status</th><th className="w-36 px-4 py-3" /></tr></thead>
              <tbody className="divide-y divide-border">
                {migrations.map((migration) => {
                  const active = activeMigrationStatuses.includes(migration.status)
                  const valid = migration.validation?.filter((item) => item.match).length || 0
                  return <tr key={migration.id}>
                    <td className="px-4 py-3"><p className="font-medium">{migration.project_name}</p><p className="text-xs text-muted-foreground">{new Date(migration.created_at).toLocaleString()}</p></td>
                    <td className="px-4 py-3"><p>{providerLabels[migration.source_provider]}</p><p className="font-mono text-[11px] text-muted-foreground">{migration.source_database}</p></td>
                    <td className="px-4 py-3"><p>{providerLabels[migration.target_provider]}</p><p className="font-mono text-[11px] text-muted-foreground">{migration.target_database}</p></td>
                    <td className="px-4 py-3"><p>{migration.table_map.length}</p>{migration.validation && <p className="text-xs text-muted-foreground">{valid}/{migration.validation.length} verified</p>}</td>
                    <td className="px-4 py-3"><Badge variant={migration.status === 'failed' ? 'destructive' : 'secondary'} className={migration.status === 'succeeded' || migration.status === 'activated' ? 'bg-emerald-500/15 text-emerald-300' : ''}>{active && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{migration.status}</Badge>{migration.error && <p className="mt-1 max-w-xs truncate text-xs text-destructive">{migration.error}</p>}</td>
                    <td className="px-4 py-3"><div className="flex items-center justify-end gap-1"><Button variant="ghost" size="icon" title="Migration details" onClick={() => setMigrationDetails(migration)}><Eye className="h-4 w-4" /></Button>{active && isAdmin && <Button variant="ghost" size="icon" title="Cancel migration" onClick={() => void cancelMigration(migration)} disabled={!!busy}><StopCircle className="h-4 w-4" /></Button>}{migration.status === 'succeeded' && isAdmin && <Button variant="ghost" size="icon" title="Activate target" onClick={() => void activateMigration(migration)} disabled={!!busy}><Power className="h-4 w-4" /></Button>}{isAdmin && <DataRemovalAction kind="migration" name={`${migration.source_database} to ${migration.target_database}`} endpoint={`/api/data/migrations/${migration.id}`} blockedReason={migration.removal_blocked_reason} disabled={!!busy} onRemoved={async () => { if (migrationDetails?.id === migration.id) setMigrationDetails(null); await refresh() }} />}</div></td>
                  </tr>
                })}
                {!migrations.length && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No database migrations recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>}
      </div>

      <Sheet open={migrationOpen} onOpenChange={(open) => { setMigrationOpen(open); if (!open) setMigrationPreview(null) }}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader><SheetTitle>Migrate project database</SheetTitle><SheetDescription>PostgreSQL, MySQL, MariaDB, and SQL Server</SheetDescription></SheetHeader>
          <div className="mt-6 grid gap-4">
            <label className="grid gap-2 text-sm">Source service<select className={inputClass} value={migrationForm.sourceServiceId} onChange={(e) => { setMigrationForm({ sourceServiceId: e.target.value, targetServiceId: '', preserveSchema: migrationForm.preserveSchema, replaceTarget: false }); setMigrationPreview(null) }}><option value="">Select source</option>{services.filter((service) => relationalProviders.includes(service.provider)).map((service) => <option key={service.id} value={service.id}>{service.project_name} · {service.name} · {providerLabels[service.provider]}</option>)}</select></label>
            <label className="grid gap-2 text-sm">Target service<select className={inputClass} value={migrationForm.targetServiceId} onChange={(e) => { setMigrationForm({ ...migrationForm, targetServiceId: e.target.value, replaceTarget: false }); setMigrationPreview(null) }} disabled={!migrationSource}><option value="">Select target</option>{migrationTargets.map((service) => <option key={service.id} value={service.id}>{service.name} · {providerLabels[service.provider]} · {service.database_name}</option>)}</select></label>
            <label className="flex items-center justify-between border-y border-border py-3 text-sm"><span><span className="block">Preserve compatible schema</span><span className="mt-1 block text-xs text-muted-foreground">Columns and supported keys are translated; review provider-specific constraints after migration.</span></span><Switch checked={migrationForm.preserveSchema} onCheckedChange={(preserveSchema) => setMigrationForm({ ...migrationForm, preserveSchema })} /></label>
            {!migrationPreview && <Button onClick={() => void previewMigration()} disabled={busy === 'migration-preview' || !migrationForm.sourceServiceId || !migrationForm.targetServiceId}>{busy === 'migration-preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}Preview migration</Button>}
            {migrationPreview && <div className="space-y-4">
              <div className="border-y border-border py-3 text-sm"><div className="flex items-center justify-between"><span>Tables</span><span className="font-medium">{migrationPreview.tables.length}</span></div><div className="mt-2 flex items-center justify-between"><span>Existing targets</span><span className={migrationPreview.existingTargetTables ? 'font-medium text-amber-400' : 'font-medium'}>{migrationPreview.existingTargetTables}</span></div></div>
              <div className="max-h-52 overflow-y-auto border-y border-border text-xs">{migrationPreview.tables.map((table) => <div key={table.sourceObject} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border/50 px-2 py-2 last:border-0"><span className="truncate font-mono">{table.sourceObject}</span><ArrowRightLeft className="h-3 w-3 text-muted-foreground" /><span className="truncate font-mono">{table.targetObject}{table.targetExists ? ' · replace' : ''}</span></div>)}</div>
              {migrationPreview.existingTargetTables > 0 && <label className="flex items-center justify-between border-y border-border py-3 text-sm"><span>Replace existing target tables</span><Switch checked={migrationForm.replaceTarget} onCheckedChange={(replaceTarget) => setMigrationForm({ ...migrationForm, replaceTarget })} /></label>}
              <Button onClick={() => void startMigration()} disabled={busy === 'migration-start' || (migrationPreview.existingTargetTables > 0 && !migrationForm.replaceTarget)}>{busy === 'migration-start' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Start migration</Button>
            </div>}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={migrationDetails !== null} onOpenChange={(open) => !open && setMigrationDetails(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader><SheetTitle>Migration details</SheetTitle><SheetDescription>{migrationDetails ? `${providerLabels[migrationDetails.source_provider]} to ${providerLabels[migrationDetails.target_provider]} · ${migrationDetails.status}` : ''}</SheetDescription></SheetHeader>
          {migrationDetails && <div className="mt-6 space-y-5">
            <div className="grid grid-cols-2 gap-4 border-y border-border py-4 text-sm"><div><p className="text-xs text-muted-foreground">Source</p><p className="mt-1 font-mono text-xs">{migrationDetails.source_database}</p></div><div><p className="text-xs text-muted-foreground">Target</p><p className="mt-1 font-mono text-xs">{migrationDetails.target_database}</p></div></div>
            {migrationDetails.validation && <div><p className="mb-2 text-sm font-medium">Row-count validation</p><div className="max-h-56 overflow-y-auto border-y border-border">{migrationDetails.validation.map((item) => <div key={item.table} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border/50 px-2 py-2 text-xs last:border-0">{item.match ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}<span className="truncate font-mono">{item.table}</span><span>{item.sourceRows} / {item.targetRows}</span></div>)}</div></div>}
            <div><p className="mb-2 text-sm font-medium">Execution log</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap bg-muted/40 p-3 font-mono text-xs">{migrationDetails.log || 'Waiting for migration output...'}</pre></div>
          </div>}
        </SheetContent>
      </Sheet>

      <Sheet open={catalogOpen} onOpenChange={(open) => { setCatalogOpen(open); if (!open) void refresh() }}><SheetContent className="w-full overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>Add a database server</SheetTitle><SheetDescription>Install an engine on this server or connect one that runs elsewhere. Apps then get their own database on it from their project.</SheetDescription></SheetHeader><div className="mt-6 space-y-4"><ServiceCatalog role={isAdmin ? 'admin' : 'viewer'} onSelect={() => undefined} /><p className="text-xs text-muted-foreground">Need a dedicated server for one app, a read-only external service, or TLS options? <button type="button" className="text-foreground underline-offset-4 hover:underline" onClick={() => { setCatalogOpen(false); setConnectionOpen(true) }}>Use the advanced connection form</button>.</p></div></SheetContent></Sheet>

      <Sheet open={connectionOpen} onOpenChange={(open) => { setConnectionOpen(open); if (!open) void refresh() }}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>Advanced server connection</SheetTitle><SheetDescription>Register application infrastructure. The Manager control database cannot be used for project provisioning.</SheetDescription></SheetHeader><div className="mt-6 grid gap-4"><label className="grid gap-2 text-sm">Name<input className={inputClass} value={connectionForm.name} onChange={(e) => setConnectionForm({ ...connectionForm, name: e.target.value })} placeholder="Application PostgreSQL" /></label><label className="grid gap-2 text-sm">Provider<select className={inputClass} value={connectionForm.provider} onChange={(e) => { const provider=e.target.value as Provider; setConnectionForm({ ...connectionForm, provider, port: defaultPorts[provider] }) }}>{Object.entries(providerLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="grid gap-2 text-sm">Purpose<select className={inputClass} value={connectionForm.purpose} onChange={(e) => setConnectionForm({ ...connectionForm, purpose: e.target.value as ConnectionPurpose })}>{Object.entries(purposeLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="grid grid-cols-[1fr_7rem] gap-3"><label className="grid gap-2 text-sm">Host<input className={inputClass} value={connectionForm.host} onChange={(e) => setConnectionForm({ ...connectionForm, host: e.target.value })} /></label><label className="grid gap-2 text-sm">Port<input className={inputClass} type="number" value={connectionForm.port} onChange={(e) => setConnectionForm({ ...connectionForm, port: Number(e.target.value) })} /></label></div><label className="grid gap-2 text-sm">Administrator username<input className={inputClass} value={connectionForm.username} onChange={(e) => setConnectionForm({ ...connectionForm, username: e.target.value })} /></label><label className="grid gap-2 text-sm">Administrator password<input className={inputClass} type="password" value={connectionForm.password} onChange={(e) => setConnectionForm({ ...connectionForm, password: e.target.value })} /></label><label className="flex items-center justify-between border-y border-border py-3 text-sm"><span>Project provisioning</span><Switch checked={connectionForm.provisioningEnabled} onCheckedChange={(checked) => setConnectionForm({ ...connectionForm, provisioningEnabled: checked })} /></label><label className="flex items-center justify-between border-b border-border pb-3 text-sm"><span>Recommended default</span><Switch checked={connectionForm.isDefault} onCheckedChange={(checked) => setConnectionForm({ ...connectionForm, isDefault: checked })} /></label><label className="flex items-center justify-between border-b border-border pb-3 text-sm"><span>Use TLS</span><Switch checked={connectionForm.tlsEnabled} onCheckedChange={(checked) => setConnectionForm({ ...connectionForm, tlsEnabled: checked })} /></label><Button onClick={() => void createConnection()} disabled={busy === 'connection-create' || !connectionForm.name || !connectionForm.host}>{busy === 'connection-create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Server className="mr-2 h-4 w-4" />}Test and save</Button></div></SheetContent></Sheet>

    </>
  )
}
