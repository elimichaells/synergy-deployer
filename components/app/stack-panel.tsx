'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AppWindow, ArrowRight, Boxes, Check, Database, Globe2, Layers, Link2, Loader2, Pencil, Server, Unlink, Workflow, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FrameworkLogo } from '@/components/synergy/framework-logo'
import { StatusDot, type DeployStatus } from '@/components/synergy/status'
import { ChoiceCard, Section, roleLabels } from './section'
import { cn } from '@/lib/utils'

interface Member { id: string; name: string; component_role: string; environment: string; project_type: string; port: number | null; url: string | null; database_count: number; deployment_status: DeployStatus | null }
interface Candidate { id: string; name: string; project_type: string; component_role: string }
interface Snapshot {
  production_id: string
  application_group_id: string | null
  group_name: string | null
  component_role: string
  members: Member[]
  candidates: Candidate[]
  canWrite: boolean
  domains: { id: string; hostname: string; project_id: string }[]
  sharedDatabases: { id: string; project_id: string; project_name: string; owner_project_id: string; owner_project_name: string; database_name: string; provider: string }[]
  routes: { id: string; hostname: string; path_prefix: string; project_id: string; project_name: string }[]
}

export const roleIcons: Record<string, typeof Server> = { frontend: AppWindow, backend: Server, service: Workflow, application: Boxes }
const roleOrder = ['frontend', 'application', 'backend', 'service']
const roleHints: Record<string, string> = {
  frontend: 'What people see in the browser',
  backend: 'API and business logic',
  service: 'Workers, queues and helpers',
  application: 'A complete app on its own',
}

export function RolePicker({ value, onChange, disabled }: { value: string; onChange: (role: string) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Role">
      {['frontend', 'backend', 'service', 'application'].map(role => {
        const Icon = roleIcons[role]
        return <ChoiceCard key={role} selected={value === role} disabled={disabled} onSelect={() => onChange(role)} icon={<Icon className="h-4 w-4" />} title={roleLabels[role]} description={roleHints[role]} />
      })}
    </div>
  )
}

export function StackPanel({ projectId, environment, compact = false }: { projectId: string; environment: string; compact?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [form, setForm] = useState({ relatedId: '', role: 'frontend', relatedRole: 'backend' })

  const load = useCallback(async () => {
    const response = await fetch(`/api/sites/${projectId}/related`, { cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not load the stack')
    setSnapshot(body)
    setForm(current => ({ ...current, role: body.component_role === 'application' ? current.role : body.component_role }))
  }, [projectId])

  useEffect(() => { void load().catch(err => setError(err.message)) }, [load])

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action(); await load() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const request = async (method: string, body?: unknown) => {
    const response = await fetch(`/api/sites/${projectId}/related`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || 'Stack update failed')
  }

  const link = () => act(async () => { await request('POST', { relatedProjectId: form.relatedId, role: form.role, relatedRole: form.relatedRole }); setLinking(false) })
  const leave = () => act(async () => { if (window.confirm('Remove this application from its stack? Its staging version leaves too.')) await request('DELETE') })
  const rename = () => act(async () => { await request('PATCH', { name: renaming }); setRenaming(null) })

  const visible = useMemo(() => (snapshot?.members || []).filter(member => member.environment === environment)
    .sort((a, b) => roleOrder.indexOf(a.component_role) - roleOrder.indexOf(b.component_role) || a.name.localeCompare(b.name)), [snapshot, environment])
  const domainOf = (id: string) => snapshot?.domains.find(domain => domain.project_id === id)?.hostname

  if (!snapshot) return <Section title="Stack">{error ? <p role="alert" className="text-sm text-red-300">{error}</p> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading stack" />}</Section>

  const inStack = !!snapshot.application_group_id
  const linkForm = (
    <form className="mt-4 space-y-4 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); void link() }}>
      <label className="field-label">Connect with<select required className="control-input" value={form.relatedId} onChange={event => {
        const candidate = snapshot.candidates.find(item => item.id === event.target.value)
        setForm({ ...form, relatedId: event.target.value, relatedRole: candidate?.component_role && candidate.component_role !== 'application' ? candidate.component_role : form.role === 'frontend' ? 'backend' : 'frontend' })
      }}><option value="">Choose an application</option>{snapshot.candidates.map(app => <option key={app.id} value={app.id}>{app.name} ({app.project_type})</option>)}</select></label>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2"><p className="text-sm font-medium">This app is the…</p><RolePicker value={form.role} onChange={role => setForm({ ...form, role })} /></div>
        <div className="space-y-2"><p className="text-sm font-medium">The other app is the…</p><RolePicker value={form.relatedRole} onChange={relatedRole => setForm({ ...form, relatedRole })} /></div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setLinking(false)}>Cancel</Button>
        <Button type="submit" disabled={busy || !form.relatedId}>{busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Link2 className="mr-1.5 h-4 w-4" />}{inStack ? 'Add to stack' : 'Create stack'}</Button>
      </div>
    </form>
  )

  if (!inStack) {
    return (
      <Section
        title={<span className="flex items-center gap-2"><Layers className="h-4 w-4" />Stack</span>}
        description="This application stands alone. Put a frontend, its backend API and supporting services in one stack so they can share a database and one domain, and are shown together."
        action={snapshot.canWrite && !linking ? <Button variant="outline" size="sm" onClick={() => setLinking(true)} disabled={!snapshot.candidates.length}><Link2 className="mr-1.5 h-4 w-4" />Create a stack</Button> : undefined}
      >
        {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
        {linking ? linkForm : !compact && (
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-xs text-muted-foreground">
            {['frontend', 'backend', 'service'].map((role, index) => {
              const Icon = roleIcons[role]
              return <span key={role} className="flex items-center gap-3">{index > 0 && <ArrowRight className="h-3.5 w-3.5" />}<span className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5"><Icon className="h-3.5 w-3.5" />{roleLabels[role]}</span></span>
            })}
            <span className="flex items-center gap-3"><ArrowRight className="h-3.5 w-3.5" /><span className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5"><Database className="h-3.5 w-3.5" />Shared database</span></span>
          </div>
        )}
      </Section>
    )
  }

  return (
    <Section
      title={renaming !== null ? (
        <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); void rename() }}>
          <input autoFocus className="control-input h-8 w-56" value={renaming} onChange={event => setRenaming(event.target.value)} aria-label="Stack name" />
          <Button type="submit" size="icon" className="h-8 w-8" disabled={busy || !renaming.trim()} aria-label="Save name"><Check className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setRenaming(null)} aria-label="Cancel"><X className="h-4 w-4" /></Button>
        </form>
      ) : (
        <span className="flex items-center gap-2"><Layers className="h-4 w-4 text-syn-violet" />{snapshot.group_name || 'Stack'}
          {snapshot.canWrite && <button type="button" onClick={() => setRenaming(snapshot.group_name || '')} className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" aria-label="Rename stack"><Pencil className="h-3.5 w-3.5" /></button>}
        </span>
      )}
      description={<>This app is the <strong className="font-medium text-foreground">{roleLabels[snapshot.component_role] || snapshot.component_role}</strong> of this stack. Stack apps can share databases and one domain.</>}
      action={snapshot.canWrite ? <>
        {!linking && <Button variant="outline" size="sm" onClick={() => setLinking(true)} disabled={!snapshot.candidates.length}><Link2 className="mr-1.5 h-4 w-4" />Add app</Button>}
        <Button variant="ghost" size="sm" onClick={() => void leave()} disabled={busy}><Unlink className="mr-1.5 h-4 w-4" />Leave</Button>
      </> : undefined}
    >
      {error && <p role="alert" className="mb-3 rounded-md border border-red-400/25 bg-red-400/5 px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
        {visible.map((member, index) => {
          const Icon = roleIcons[member.component_role] || Boxes
          const current = member.id === projectId
          return (
            <div key={member.id} className="flex flex-1 flex-col items-stretch gap-2 lg:flex-row lg:items-center">
              {index > 0 && <div className="flex justify-center text-muted-foreground lg:px-1"><ArrowRight className="h-4 w-4 rotate-90 lg:rotate-0" /></div>}
              <Link href={`/sites/${member.id}`} aria-current={current ? 'page' : undefined}
                className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-lg border p-3 transition-colors', current ? 'border-foreground/50 bg-white/[0.04]' : 'border-border hover:border-white/25')}>
                <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-black"><FrameworkLogo type={member.project_type} className="h-5 w-5" />
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card"><Icon className="h-2.5 w-2.5" /></span></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">{member.name}{current && <span className="text-[10px] font-normal text-muted-foreground">(this app)</span>}</span>
                  <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {member.deployment_status && <StatusDot status={member.deployment_status} className="scale-75" />}
                    {roleLabels[member.component_role]}{domainOf(member.id) ? ` · ${domainOf(member.id)}` : member.port ? ` · :${member.port}` : ''}
                  </span>
                </span>
              </Link>
            </div>
          )
        })}
      </div>

      {(snapshot.routes.length > 0 || snapshot.sharedDatabases.length > 0) && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {snapshot.routes.map(item => (
            <div key={item.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"><Globe2 className="h-3.5 w-3.5 shrink-0 text-syn-cyan" /><span className="truncate font-mono">{item.hostname}{item.path_prefix}</span><ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{item.project_name}</span></div>
          ))}
          {snapshot.sharedDatabases.map(item => (
            <div key={item.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"><Database className="h-3.5 w-3.5 shrink-0 text-syn-violet" /><span className="truncate font-mono">{item.database_name}</span><span className="truncate text-muted-foreground">{item.owner_project_name} → {item.project_name}</span></div>
          ))}
        </div>
      )}
      {linking && linkForm}
    </Section>
  )
}
