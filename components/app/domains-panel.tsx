'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ArrowUpRight, Cloud, CornerDownRight, Globe2, Layers, Loader2, Lock, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ChoiceCard, Section, roleLabels } from './section'
import { cn } from '@/lib/utils'

interface Domain { id: string; hostname: string; dns_status: string; ssl_status: string; record_type: string; record_content: string; is_primary: boolean; cloudflare_connection_id: string | null }
interface Route { id: string; domain_id: string; hostname: string; domain_project_id: string; domain_project_name: string; project_id: string; project_name: string; component_role: string; path_prefix: string; strip_prefix: boolean }
interface StackMember { id: string; name: string; component_role: string; environment: string }
interface StackDomain { id: string; hostname: string; project_id: string }
interface Stack { application_group_id: string | null; group_name: string | null; component_role: string; members: StackMember[]; domains: StackDomain[] }

const statusTone = (value: string) => ['active', 'strict', 'manual'].includes(value) ? 'text-status-ready' : value === 'error' ? 'text-status-failed' : 'text-status-building'

export function DomainsPanel({ projectId, projectName, port, environment, role, onChanged }: {
  projectId: string
  projectName: string
  port: number | null
  environment: string
  role: 'admin' | 'operator' | 'viewer'
  onChanged?: () => void
}) {
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [stack, setStack] = useState<Stack | null>(null)
  const [connections, setConnections] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ mode: 'manual', hostname: '', cloudflareConnectionId: '', recordType: 'A', recordContent: '', proxied: true, isPrimary: true })
  const [route, setRoute] = useState({ domainId: '', pathPrefix: '/api', stripPrefix: false })
  const isAdmin = role === 'admin'

  const load = useCallback(async () => {
    const [domainRes, routeRes, stackRes, connectionRes] = await Promise.all([
      fetch(`/api/domains?project=${projectId}`, { cache: 'no-store' }),
      fetch(`/api/domains/routes?project=${projectId}`, { cache: 'no-store' }),
      fetch(`/api/sites/${projectId}/related`, { cache: 'no-store' }),
      fetch('/api/cloudflare/connections'),
    ])
    if (!domainRes.ok) throw new Error('Could not load domains')
    setDomains((await domainRes.json()).domains || [])
    if (routeRes.ok) setRoutes((await routeRes.json()).routes || [])
    if (stackRes.ok) setStack(await stackRes.json())
    if (connectionRes.ok) setConnections((await connectionRes.json()).connections || [])
  }, [projectId])

  useEffect(() => { void load().catch(err => setError(err.message)) }, [load])

  const members = useMemo(() => new Map((stack?.members || []).map(member => [member.id, member])), [stack])
  // Domains of sibling apps in the same environment that this app could live under.
  const siblingDomains = useMemo(() => (stack?.domains || []).filter(domain => domain.project_id !== projectId && members.get(domain.project_id)?.environment === environment), [stack, members, projectId, environment])
  const incoming = routes.filter(item => item.project_id === projectId)
  const outgoing = (domainId: string) => routes.filter(item => item.domain_id === domainId)
  const suggestedHost = useMemo(() => {
    const base = siblingDomains[0]?.hostname.split('.').slice(-2).join('.')
    if (!base) return ''
    const prefix = stack?.component_role === 'backend' ? 'api' : stack?.component_role === 'frontend' ? 'app' : projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return `${prefix}.${base}`
  }, [siblingDomains, stack, projectName])

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action(); await load(); onChanged?.() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const addDomain = () => act(async () => {
    const response = await fetch('/api/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, projectId }) })
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Domain could not be added')
    setAddOpen(false); setForm(current => ({ ...current, hostname: '' }))
  })

  const removeDomain = (domain: Domain) => act(async () => {
    if (!window.confirm(`Remove ${domain.hostname}? Traffic to it stops being served${domain.cloudflare_connection_id ? ' and its Cloudflare DNS record is deleted' : ''}.`)) return
    const response = await fetch(`/api/domains/${domain.id}`, { method: 'DELETE' })
    const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Domain could not be removed')
  })

  const addRoute = () => act(async () => {
    const response = await fetch('/api/domains/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...route, domainId: route.domainId || siblingDomains[0]?.id, projectId }) })
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Route could not be added')
  })

  const removeRoute = (item: Route) => act(async () => {
    if (!window.confirm(`Stop serving ${item.project_name} at ${item.hostname}${item.path_prefix}?`)) return
    const response = await fetch(`/api/domains/routes/${item.id}`, { method: 'DELETE' })
    const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Route could not be removed')
  })

  const openAdd = () => {
    setForm(current => ({ ...current, hostname: suggestedHost, isPrimary: !domains?.some(domain => domain.is_primary) }))
    setAddOpen(true)
  }

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="notice-error">{error}</div>}
      <Section
        title="Domains"
        description="Public addresses for this application. Synergy routes them to the app and issues HTTPS certificates automatically."
        action={<Button size="sm" onClick={openAdd} disabled={!isAdmin || !port}><Plus className="mr-1.5 h-4 w-4" />Add domain</Button>}
        footer={!port ? <span>Assign a port in Settings before adding a domain.</span> : !isAdmin ? <span>An administrator can add or remove domains.</span> : undefined}
      >
        {domains === null ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading domains" /></div>
          : domains.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
              <Globe2 className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium">No domain yet</p>
              <p className="mt-1 text-xs text-muted-foreground">{port ? `Reachable on the server at localhost:${port}.` : 'Not reachable until it has a port.'} {siblingDomains.length ? 'You can also serve it under a project domain below.' : ''}</p>
            </div>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {domains.map(domain => (
                <div key={domain.id} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium hover:underline">{domain.hostname}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" /></a>
                    {domain.is_primary && <span className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-px text-[11px] font-medium">Primary</span>}
                    <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{domain.cloudflare_connection_id ? 'Cloudflare' : 'Manual DNS'}</span>
                      <span>DNS <span className={statusTone(domain.dns_status)}>{domain.dns_status}</span></span>
                      <span>TLS <span className={statusTone(domain.ssl_status)}>{domain.ssl_status}</span></span>
                      {isAdmin && <button type="button" onClick={() => void removeDomain(domain)} disabled={busy} className="rounded p-1 hover:bg-white/[0.06] hover:text-red-300" aria-label={`Remove ${domain.hostname}`}><Trash2 className="h-3.5 w-3.5" /></button>}
                    </span>
                  </div>
                  {domain.dns_status === 'manual' && <p className="mt-2 pl-7 text-xs text-muted-foreground">Point a <span className="font-mono">{domain.record_type}</span> record for <span className="font-mono">{domain.hostname}</span> to <span className="font-mono">{domain.record_content}</span> at your DNS provider.</p>}
                  {outgoing(domain.id).map(item => (
                    <div key={item.id} className="mt-2 flex items-center gap-2 pl-7 text-xs text-muted-foreground">
                      <CornerDownRight className="h-3.5 w-3.5" />
                      <span className="font-mono text-foreground">{item.path_prefix}</span>
                      <ArrowRight className="h-3 w-3" />
                      <Link href={`/sites/${item.project_id}?tab=domains`} className="hover:text-foreground hover:underline">{item.project_name}</Link>
                      <span>({roleLabels[item.component_role] || item.component_role})</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
      </Section>

      {stack?.application_group_id && (
        <Section
          title={<span className="flex items-center gap-2"><Layers className="h-4 w-4" />Share a domain with your project</span>}
          description={<>Serve {projectName} under a path of another {stack.group_name ? <strong className="font-medium text-foreground">{stack.group_name}</strong> : 'project'} app&apos;s domain, for example <span className="font-mono text-foreground">{siblingDomains[0]?.hostname || 'app.example.com'}/api</span>. One address and one certificate, and no cross-origin setup for your frontend.</>}
          footer={<span>Requests matching the path go to this app; everything else keeps going to the domain&apos;s own app.</span>}
        >
          {incoming.length > 0 && (
            <div className="mb-4 divide-y divide-border overflow-hidden rounded-lg border border-border">
              {incoming.map(item => (
                <div key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <Globe2 className="h-4 w-4 text-muted-foreground" />
                  <a href={`https://${item.hostname}${item.path_prefix}`} target="_blank" rel="noreferrer" className="font-mono hover:underline">{item.hostname}<span className="text-syn-cyan">{item.path_prefix}</span></a>
                  <span className="text-xs text-muted-foreground">on {item.domain_project_name}{item.strip_prefix ? ` · ${item.path_prefix} removed before forwarding` : ''}</span>
                  {isAdmin && <button type="button" onClick={() => void removeRoute(item)} disabled={busy} className="ml-auto rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-red-300" aria-label={`Remove route ${item.path_prefix}`}><Trash2 className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
            </div>
          )}
          {siblingDomains.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No other {environment} app in this project has a domain yet. Add one to the frontend first, then route a path of it here.</p>
          ) : (
            <form className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end" onSubmit={event => { event.preventDefault(); void addRoute() }}>
              <label className="field-label">Domain<select className="control-input" value={route.domainId || siblingDomains[0].id} onChange={event => setRoute({ ...route, domainId: event.target.value })}>
                {siblingDomains.map(domain => <option key={domain.id} value={domain.id}>{domain.hostname} · {members.get(domain.project_id)?.name}</option>)}
              </select></label>
              <label className="field-label">Path<input className="control-input font-mono" value={route.pathPrefix} onChange={event => setRoute({ ...route, pathPrefix: event.target.value })} placeholder="/api" /></label>
              <Button type="submit" disabled={!isAdmin || busy || !port}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}Add route
              </Button>
              <label className="flex items-center gap-3 text-sm sm:col-span-3">
                <Switch checked={route.stripPrefix} onCheckedChange={stripPrefix => setRoute({ ...route, stripPrefix })} />
                <span>Remove <span className="font-mono">{route.pathPrefix || '/api'}</span> before forwarding <span className="text-muted-foreground">— turn on if your app expects requests at <span className="font-mono">/</span> instead of <span className="font-mono">{route.pathPrefix || '/api'}/…</span></span></span>
              </label>
            </form>
          )}
        </Section>
      )}

      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader><SheetTitle>Add a domain</SheetTitle><SheetDescription>{projectName} · HTTPS is set up automatically once DNS points at this server</SheetDescription></SheetHeader>
          <form className="mt-6 space-y-5" onSubmit={event => { event.preventDefault(); void addDomain() }}>
            <label className="field-label">Domain<input required className="control-input" value={form.hostname} onChange={event => setForm({ ...form, hostname: event.target.value })} placeholder={suggestedHost || 'app.example.com'} /></label>
            {suggestedHost && <p className="-mt-3 text-xs text-muted-foreground">Suggested from your project: <button type="button" className="font-mono text-foreground hover:underline" onClick={() => setForm({ ...form, hostname: suggestedHost })}>{suggestedHost}</button></p>}
            <div className="grid gap-2" role="radiogroup" aria-label="DNS management">
              <ChoiceCard selected={form.mode === 'manual'} onSelect={() => setForm({ ...form, mode: 'manual' })} icon={<Globe2 className="h-4 w-4" />} title="I'll update DNS myself" description="Add the record at your DNS provider. Synergy shows you exactly what to enter." />
              <ChoiceCard selected={form.mode === 'cloudflare'} onSelect={() => setForm({ ...form, mode: 'cloudflare' })} disabled={!connections.length} icon={<Cloud className="h-4 w-4" />} title="Let Synergy manage it in Cloudflare" description={connections.length ? 'Creates the DNS record for you.' : 'Connect a Cloudflare account in Domains first.'} />
            </div>
            {form.mode === 'cloudflare' && <label className="field-label">Cloudflare account<select required className="control-input" value={form.cloudflareConnectionId} onChange={event => setForm({ ...form, cloudflareConnectionId: event.target.value })}><option value="">Select account</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>}
            <div className="grid gap-4 sm:grid-cols-[110px_minmax(0,1fr)]">
              <label className="field-label">Record<select className="control-input" value={form.recordType} onChange={event => setForm({ ...form, recordType: event.target.value })}>{['A', 'AAAA', 'CNAME'].map(type => <option key={type}>{type}</option>)}</select></label>
              <label className="field-label">{form.recordType === 'CNAME' ? 'Points to hostname' : "This server's public IP"}<input required className="control-input font-mono" value={form.recordContent} onChange={event => setForm({ ...form, recordContent: event.target.value })} placeholder={form.recordType === 'CNAME' ? 'origin.example.com' : form.recordType === 'AAAA' ? '2001:db8::1' : '203.0.113.10'} /></label>
            </div>
            <div className="divide-y divide-border rounded-lg border border-border">
              <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Primary domain</span><span className="block text-xs text-muted-foreground">Shown as this app&apos;s address everywhere in Synergy.</span></span><Switch checked={form.isPrimary} onCheckedChange={isPrimary => setForm({ ...form, isPrimary })} /></label>
              {form.mode === 'cloudflare' && <label className="flex items-center justify-between gap-4 px-4 py-3 text-sm"><span><span className="block font-medium">Cloudflare proxy</span><span className="block text-xs text-muted-foreground">Orange cloud: CDN and DDoS protection in front of this server.</span></span><Switch checked={form.proxied} onCheckedChange={proxied => setForm({ ...form, proxied })} /></label>}
            </div>
            <p className={cn('rounded-md border border-border bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground')}>Synergy will serve <span className="font-mono text-foreground">{form.hostname || 'your domain'}</span> from port <span className="font-mono text-foreground">{port}</span>{form.mode === 'manual' ? '. No DNS changes are made for you.' : ' and create the DNS record in Cloudflare.'}</p>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || !form.hostname || !form.recordContent || (form.mode === 'cloudflare' && !form.cloudflareConnectionId)}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe2 className="mr-2 h-4 w-4" />}Add domain</Button>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  )
}
