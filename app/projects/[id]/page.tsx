'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowRight, ArrowUpRight, Boxes, Check, ChevronDown, CornerDownRight, Database, Github, Globe2, Layers, Link2, Loader2, Pencil, Plus, Rocket, Unlink, Workflow, X } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FrameworkAvatar, FrameworkLogo } from '@/components/synergy/framework-logo'
import { StatusLabel, type DeployStatus } from '@/components/synergy/status'
import { Section, roleLabels } from '@/components/app/section'
import { RolePicker, roleIcons } from '@/components/app/stack-panel'
import { ProviderLogo, providerMeta, type Provider } from '@/components/app/providers'
import { ProjectServiceSheet } from '@/components/app/project-service-sheet'
import { relativeTime } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface App { id: string; name: string; component_role: string; environment: 'production' | 'staging'; project_type: string; port: number | null; url: string | null; is_active: boolean; production_id: string | null; setup_required: boolean; repo_url: string | null; default_branch: string; deployment_status: DeployStatus | null; deployed_at: string | null }
interface Domain { id: string; hostname: string; project_id: string; is_primary: boolean; dns_status: string; ssl_status: string }
interface Route { id: string; domain_id: string; hostname: string; domain_project_id: string; project_id: string; path_prefix: string; strip_prefix: boolean }
interface DatabaseRow { id: string; project_id: string; name: string; database_name: string; application_primary: boolean; options: { ownership?: string; sharedFrom?: string }; provider: Provider; connection_name: string; backup_status: string | null; backup_frequency: string | null }
interface Project { id: string; name: string; apps: App[]; domains: Domain[]; routes: Route[]; databases: DatabaseRow[] }
interface Candidate { appId: string; name: string; project_type: string; projectName: string }

const TABS = ['overview', 'apps', 'storage', 'domains', 'jobs', 'settings'] as const
type Tab = typeof TABS[number]
const menuItem = 'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-muted-foreground outline-none data-[highlighted]:bg-white/[0.06] data-[highlighted]:text-foreground'

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [access, setAccess] = useState({ canWrite: false, isAdmin: false })
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [environment, setEnvironment] = useState<'production' | 'staging'>('production')
  const [serviceOpen, setServiceOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [link, setLink] = useState({ appId: '', role: 'backend' })
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const response = await fetch(`/api/groups/${id}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Could not load the project')
    setProject(body.project)
    setAccess({ canWrite: body.canWrite, isAdmin: body.isAdmin })
    setNow(Date.now())
  }, [id])

  useEffect(() => { void load().catch(err => setError(err.message)) }, [load])
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('tab')
    if (TABS.includes(value as Tab)) setTab(value as Tab)
  }, [])

  const changeTab = (value: string) => {
    setTab(value as Tab)
    window.history.replaceState(null, '', `?tab=${value}`)
  }

  const apps = useMemo(() => (project?.apps || []).filter(app => app.environment === environment), [project, environment])
  const hasStaging = !!project?.apps.some(app => app.environment === 'staging')
  const appName = (appId: string) => project?.apps.find(app => app.id === appId)?.name || 'app'
  const owned = useMemo(() => (project?.databases || []).filter(row => row.options?.ownership !== 'shared' && apps.some(app => app.id === row.project_id)), [project, apps])
  const usersOf = (row: DatabaseRow) => (project?.databases || []).filter(other => other.options?.sharedFrom === row.id).map(other => other.project_id)
  const appsWithMainDatabase = useMemo(() => (project?.databases || []).filter(row => row.application_primary).map(row => row.project_id), [project])
  const anchor = project?.apps.find(app => app.environment === 'production')
  // Managed domains plus any address set by hand as an app's URL.
  const addresses = useMemo(() => {
    const managed = (project?.domains || []).filter(domain => apps.some(app => app.id === domain.project_id))
    const known = new Set(managed.map(domain => domain.hostname))
    const manual = apps.filter(app => app.url).map(app => ({ id: `url-${app.id}`, hostname: app.url!.replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase(), project_id: app.id, is_primary: false, manual: true }))
      .filter(entry => entry.hostname && !known.has(entry.hostname))
    return [...managed.map(domain => ({ ...domain, manual: false })), ...manual]
  }, [project, apps])

  const deploy = async (app: App) => {
    setBusy(app.id); setError('')
    try {
      const response = await fetch(`/api/sites/${app.id}/deploy`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Deployment failed to start')
      if (body.deploymentId) router.push(`/deployments/${body.deploymentId}`)
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const rename = async () => {
    setBusy('rename'); setError('')
    try {
      const response = await fetch(`/api/groups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: renaming }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Rename failed')
      setRenaming(null); await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const openLink = async () => {
    setLinkOpen(true); setError('')
    const response = await fetch('/api/groups', { cache: 'no-store' }).catch(() => null)
    const body = response?.ok ? await response.json() : { projects: [] }
    // Only apps that are alone in their project can move in; larger projects stay intact.
    setCandidates((body.projects as { id: string; name: string; apps: App[] }[]).filter(other => other.id !== id)
      .map(other => ({ other, production: other.apps.filter(app => app.environment === 'production') }))
      .filter(({ production }) => production.length === 1)
      .map(({ other, production }) => ({ appId: production[0].id, name: production[0].name, project_type: production[0].project_type, projectName: other.name })))
    setLink({ appId: '', role: apps.some(app => app.component_role === 'backend') ? 'frontend' : 'backend' })
  }

  const linkApp = async () => {
    if (!anchor || !link.appId) return
    setBusy('link'); setError('')
    try {
      const response = await fetch(`/api/sites/${link.appId}/related`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relatedProjectId: anchor.id, role: link.role }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The app could not be added')
      setLinkOpen(false); setNotice(`${candidates.find(item => item.appId === link.appId)?.name} added to ${project?.name}.`); await load()
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  const removeApp = async (app: App) => {
    if (!window.confirm(`Move ${app.name} out of ${project?.name} into a project of its own? Its staging copy moves too.`)) return
    setBusy(app.id); setError('')
    try {
      const response = await fetch(`/api/sites/${app.id}/related`, { method: 'DELETE' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'The app could not be moved')
      await load()
      if (!project?.apps.some(other => other.id !== app.id && other.production_id !== app.id)) router.push('/projects')
    } catch (err) { setError((err as Error).message) } finally { setBusy(null) }
  }

  if (!project) {
    return (
      <AppShell title={error ? 'Project not found' : 'Loading project…'} back={{ href: '/projects', label: 'Projects' }}>
        {error ? <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">{error}</div> : <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />}
      </AppShell>
    )
  }

  const role = access.isAdmin ? 'admin' : access.canWrite ? 'operator' : 'viewer'
  const productionApps = project.apps.filter(app => app.environment === 'production')
  const tabs = (
    <TabsList className="scrollbar-none h-auto min-h-0 w-full justify-start gap-0 overflow-x-auto border-0 bg-transparent p-0">
      {TABS.map(value => (
        <TabsTrigger key={value} value={value} className="group relative min-h-0 rounded-none border-0 px-1 pb-3 pt-1 text-[13px] font-normal text-muted-foreground data-[state=active]:text-foreground">
          <span className="rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">{{ overview: 'Overview', apps: 'Apps', storage: 'Storage', domains: 'Domains', jobs: 'Jobs', settings: 'Settings' }[value]}</span>
          <span className="absolute inset-x-2 bottom-0 hidden h-[2px] rounded-full bg-foreground group-data-[state=active]:block" aria-hidden="true" />
        </TabsTrigger>
      ))}
    </TabsList>
  )

  const addAppMenu = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><Button variant="outline" size="sm" disabled={!access.canWrite}><Plus className="mr-1.5 h-4 w-4" />Add app<ChevronDown className="ml-1 h-3.5 w-3.5" /></Button></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-64 rounded-lg border border-white/10 bg-popover p-1 shadow-2xl shadow-black/60">
          <DropdownMenu.Item asChild className={menuItem}><Link href={`/sites/new?project=${project.id}`}><Github className="h-4 w-4" /><span><span className="block text-foreground">Import from GitHub</span><span className="block text-xs">A new repo, e.g. the backend API</span></span></Link></DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => void openLink()}><Link2 className="h-4 w-4" /><span><span className="block text-foreground">Add an existing app</span><span className="block text-xs">Move an app already on this server here</span></span></DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )

  const appCard = (app: App) => {
    const Icon = roleIcons[app.component_role] || Boxes
    return (
      <div key={app.id} className="syn-tile flex items-center gap-3 p-3">
        <Link href={`/sites/${app.id}`} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open ${app.name}`} />
        <FrameworkAvatar type={app.project_type} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{app.name}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="h-3 w-3" />{roleLabels[app.component_role]}</p>
        </div>
        {app.setup_required
          ? <Button asChild size="sm" variant="outline" className="relative z-10 h-7 text-xs"><Link href={`/sites/${app.id}?tab=setup`}>Finish setup</Link></Button>
          : app.deployment_status ? <StatusLabel status={app.deployment_status} className="text-xs" /> : <span className="text-xs text-muted-foreground">Not deployed</span>}
      </div>
    )
  }

  return (
    <Tabs value={tab} onValueChange={changeTab}>
      <AppShell
        title={project.name}
        back={{ href: '/projects', label: 'Projects' }}
        subtitle={`${productionApps.length} ${productionApps.length === 1 ? 'app' : 'apps'} · ${owned.length || 'no'} ${owned.length === 1 ? 'database' : 'databases'} · ${addresses.length || 'no'} ${addresses.length === 1 ? 'domain' : 'domains'}`}
        tabs={tabs}
        actions={<>
          {addAppMenu}
          <Button size="sm" onClick={() => setServiceOpen(true)} disabled={!access.canWrite}><Database className="mr-1.5 h-4 w-4" />Add service</Button>
        </>}
      >
        {error && <div role="alert" className="notice-error">{error}</div>}
        {notice && <p role="status" className="mb-5 rounded-md border border-status-ready/25 bg-status-ready/5 px-4 py-3 text-sm text-emerald-200">{notice}</p>}
        {hasStaging && (
          <div className="mb-6 flex h-8 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="Environment">
            {(['production', 'staging'] as const).map(value => <button key={value} type="button" onClick={() => setEnvironment(value)} aria-pressed={environment === value}
              className={cn('h-full rounded-[5px] px-3 text-xs capitalize', environment === value ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}>{value}</button>)}
          </div>
        )}

        <TabsContent value="overview" className="mt-0 space-y-6">
          <Section title="How it fits together" description="Requests come in through a domain, reach your apps, and the apps read and write their databases.">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,1.3fr)_auto_minmax(0,0.9fr)] lg:items-start">
              <div className="space-y-2">
                <p className="eyebrow flex items-center gap-1.5"><Globe2 className="h-3 w-3" />Domains</p>
                {addresses.map(domain => (
                  <div key={domain.id} className="rounded-lg border border-border px-3 py-2.5 text-sm">
                    <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate font-medium hover:underline">{domain.hostname}<ArrowUpRight className="h-3 w-3 shrink-0" /></a>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">→ {appName(domain.project_id)}</p>
                    {project.routes.filter(route => route.domain_id === domain.id).map(route => <p key={route.id} className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"><CornerDownRight className="h-3 w-3" /><span className="font-mono text-syn-cyan">{route.path_prefix}</span> → {appName(route.project_id)}</p>)}
                  </div>
                ))}
                {!addresses.length && <button type="button" onClick={() => changeTab('domains')} className="w-full rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground hover:border-white/25 hover:text-foreground">No domain yet · Add one</button>}
              </div>
              <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground lg:mt-9 lg:block" />
              <div className="space-y-2">
                <p className="eyebrow flex items-center gap-1.5"><Layers className="h-3 w-3" />Apps</p>
                {apps.map(appCard)}
                {access.canWrite && <Link href={`/sites/new?project=${project.id}`} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground hover:border-white/25 hover:text-foreground"><Plus className="h-3.5 w-3.5" />Add an app from GitHub</Link>}
              </div>
              <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground lg:mt-9 lg:block" />
              <div className="space-y-2">
                <p className="eyebrow flex items-center gap-1.5"><Database className="h-3 w-3" />Data</p>
                {owned.map(row => (
                  <div key={row.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                    <ProviderLogo provider={row.provider} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-medium">{row.provider === 'redis' ? row.name : row.database_name}</p>
                      <p className="truncate text-xs text-muted-foreground">Used by {[row.project_id, ...usersOf(row)].map(appName).join(', ')}</p>
                    </div>
                  </div>
                ))}
                {!owned.length && <button type="button" onClick={() => setServiceOpen(true)} disabled={!access.canWrite} className="w-full rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground hover:border-white/25 hover:text-foreground">No database · Add a service</button>}
              </div>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="apps" className="mt-0 space-y-4">
          <Section title="Apps" description="Each app is its own repository with its own deployments. Open one to see its logs, settings and environment." action={addAppMenu}>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {apps.map(app => (
                <div key={app.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5">
                  <FrameworkAvatar type={app.project_type} size="sm" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/sites/${app.id}`} className="truncate text-sm font-medium hover:underline">{app.name}</Link>
                    <p className="truncate text-xs text-muted-foreground">{roleLabels[app.component_role]} · {app.repo_url?.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || 'no repository'} · {app.default_branch}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {app.setup_required ? <span className="text-amber-200">Setup incomplete</span> : app.deployment_status ? <StatusLabel status={app.deployment_status} className="text-xs" /> : 'Not deployed'}
                    {app.deployed_at && <p className="mt-0.5">{relativeTime(app.deployed_at, now)}</p>}
                  </div>
                  <div className="flex gap-2">
                    {app.setup_required
                      ? <Button asChild size="sm" variant="outline"><Link href={`/sites/${app.id}?tab=setup`}>Finish setup</Link></Button>
                      : <Button size="sm" variant="outline" onClick={() => void deploy(app)} disabled={!access.canWrite || busy !== null || app.deployment_status === 'running'}>{busy === app.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}Deploy</Button>}
                    <Button asChild size="sm" variant="ghost"><Link href={`/sites/${app.id}`}>Open</Link></Button>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="storage" className="mt-0 space-y-4">
          <Section title="Databases & services" description="Each database belongs to one app, which manages its password and backups, and can be shared with the other apps here."
            action={<Button size="sm" onClick={() => setServiceOpen(true)} disabled={!access.canWrite}><Plus className="mr-1.5 h-4 w-4" />Add service</Button>}>
            {owned.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {owned.map(row => (
                  <div key={row.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5">
                    <ProviderLogo provider={row.provider} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium">{row.provider === 'redis' ? `${row.name} · db ${row.database_name}` : row.database_name}</p>
                      <p className="truncate text-xs text-muted-foreground">{providerMeta[row.provider]?.label} on {row.connection_name}{row.backup_frequency ? ` · ${row.backup_frequency} backups${row.backup_status ? ` (${row.backup_status})` : ''}` : ''}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {[row.project_id, ...usersOf(row)].map((appId, index) => <span key={appId} className={cn('rounded-full border px-2 py-px text-[11px]', index === 0 ? 'border-white/15 bg-white/[0.06] text-foreground' : 'border-border text-muted-foreground')}>{appName(appId)}{index === 0 ? ' · owner' : ''}</span>)}
                    </div>
                    <Button asChild size="sm" variant="ghost"><Link href={`/sites/${row.project_id}?tab=storage`}>Manage</Link></Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
                <Database className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                <p className="text-sm font-medium">No databases yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Add PostgreSQL, MySQL, MongoDB and more. Synergy installs the engine on this server if it isn&apos;t there yet.</p>
                <Button size="sm" className="mt-4" onClick={() => setServiceOpen(true)} disabled={!access.canWrite}><Plus className="mr-1.5 h-4 w-4" />Add service</Button>
              </div>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="domains" className="mt-0 space-y-4">
          <Section title="Domains" description="Public addresses for the apps in this project. A frontend can share its domain with the backend by path, for example /api."
            action={<DropdownMenu.Root>
              <DropdownMenu.Trigger asChild><Button size="sm" disabled={!access.isAdmin}><Plus className="mr-1.5 h-4 w-4" />Add domain<ChevronDown className="ml-1 h-3.5 w-3.5" /></Button></DropdownMenu.Trigger>
              <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-56 rounded-lg border border-white/10 bg-popover p-1 shadow-2xl shadow-black/60">
                <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">For which app?</p>
                {apps.map(app => <DropdownMenu.Item key={app.id} asChild className={menuItem}><Link href={`/sites/${app.id}?tab=domains`}><FrameworkLogo type={app.project_type} className="h-4 w-4" />{app.name}</Link></DropdownMenu.Item>)}
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu.Root>}>
            {addresses.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {addresses.map(domain => (
                  <div key={domain.id} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm font-medium hover:underline">{domain.hostname}<ArrowUpRight className="h-3.5 w-3.5" /></a>
                      {domain.is_primary && <span className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-px text-[11px]">Primary</span>}{domain.manual && <span className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground" title="Set as the app URL; DNS and HTTPS are not managed by Synergy">App URL</span>}
                      <span className="text-xs text-muted-foreground">→ {appName(domain.project_id)}</span>
                      <Link href={`/sites/${domain.project_id}?tab=${domain.manual ? 'settings' : 'domains'}`} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Manage</Link>
                    </div>
                    {project.routes.filter(route => route.domain_id === domain.id).map(route => (
                      <p key={route.id} className="mt-1.5 flex items-center gap-2 pl-1 text-xs text-muted-foreground"><CornerDownRight className="h-3.5 w-3.5" /><span className="font-mono text-foreground">{route.path_prefix}</span><ArrowRight className="h-3 w-3" />{appName(route.project_id)}</p>
                    ))}
                  </div>
                ))}
              </div>
            ) : <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No domains yet. Add one to the frontend, then route a path like /api to the backend from the backend&apos;s Domains tab.</p>}
          </Section>
        </TabsContent>

        <TabsContent value="jobs" className="mt-0 space-y-4">
          <Section title="Scheduled jobs & workers" description="Cron jobs and always-on background workers run inside an app's folder with its environment.">
            <div className="grid gap-2 sm:grid-cols-2">
              {apps.map(app => (
                <Link key={app.id} href={`/automation?project=${app.id}`} className="syn-tile flex items-center gap-3 px-4 py-3">
                  <Workflow className="h-4 w-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{app.name}</span><span className="block text-xs text-muted-foreground">Jobs and workers</span></span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                </Link>
              ))}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="settings" className="mt-0 space-y-6">
          <Section title="Project name" description="Shown on the Projects page and across Synergy. It doesn't change any app or address."
            footer={access.canWrite ? <><span>{renaming === null ? 'Rename freely; apps and deployments are unaffected.' : 'Press Save to apply.'}</span>
              {renaming === null ? <Button size="sm" variant="outline" onClick={() => setRenaming(project.name)}><Pencil className="mr-1.5 h-3.5 w-3.5" />Rename</Button>
                : <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setRenaming(null)}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button><Button size="sm" onClick={() => void rename()} disabled={busy === 'rename' || !renaming.trim()}><Check className="mr-1 h-3.5 w-3.5" />Save</Button></span>}</> : undefined}>
            {renaming === null ? <p className="text-sm font-medium">{project.name}</p> : <input autoFocus className="control-input max-w-md" value={renaming} onChange={event => setRenaming(event.target.value)} aria-label="Project name" />}
          </Section>
          <Section title="Apps in this project" description="Moving an app out gives it a project of its own. Remove any database or domain path it shares here first.">
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {productionApps.map(app => (
                <div key={app.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <FrameworkLogo type={app.project_type} className="h-4 w-4" />
                  <span className="flex-1">{app.name} <span className="text-xs text-muted-foreground">· {roleLabels[app.component_role]}</span></span>
                  {productionApps.length > 1 && access.canWrite && <Button size="sm" variant="ghost" onClick={() => void removeApp(app)} disabled={busy !== null}><Unlink className="mr-1.5 h-3.5 w-3.5" />Move out</Button>}
                </div>
              ))}
            </div>
          </Section>
          <Section title="Removing a project" description="A project disappears on its own when its last app is removed. Remove an app from its Settings tab." />
        </TabsContent>
      </AppShell>

      <ProjectServiceSheet open={serviceOpen} onOpenChange={setServiceOpen} projectName={project.name} apps={apps} appsWithMainDatabase={appsWithMainDatabase} role={role}
        onCreated={message => { setNotice(message); changeTab('storage'); void load() }} />

      <Sheet open={linkOpen} onOpenChange={setLinkOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader><SheetTitle>Add an existing app</SheetTitle><SheetDescription>Move an app that&apos;s already on this server into {project.name}.</SheetDescription></SheetHeader>
          <div className="mt-6 space-y-5">
            <label className="field-label">App<select className="control-input" value={link.appId} onChange={event => setLink({ ...link, appId: event.target.value })}>
              <option value="">Choose an app</option>
              {candidates.map(candidate => <option key={candidate.appId} value={candidate.appId}>{candidate.name}{candidate.projectName !== candidate.name ? ` (in ${candidate.projectName})` : ''}</option>)}
            </select></label>
            {!candidates.length && <p className="text-xs text-muted-foreground">Only apps that are alone in their own project can be moved. To import a new repository instead, use Import from GitHub.</p>}
            <div className="space-y-2"><p className="text-sm font-medium">It is the…</p><RolePicker value={link.role} onChange={value => setLink({ ...link, role: value })} /></div>
            <Button className="w-full" onClick={() => void linkApp()} disabled={busy === 'link' || !link.appId}>{busy === 'link' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}Add to {project.name}</Button>
            <p className="text-center text-xs text-muted-foreground">or <Link href={`/sites/new?project=${project.id}`} className="text-foreground underline-offset-4 hover:underline">import a new repository from GitHub</Link></p>
          </div>
        </SheetContent>
      </Sheet>
    </Tabs>
  )
}
