'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AppWindow, Server, Layers, Link2, Unlink, Loader2, Terminal, KeyRound, Database, Globe, ArrowUpRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Member { id: string; name: string; component_role: string; environment: string; project_type: string; port: number; url: string | null; database_count: number; deployment_status: string | null; default_branch: string }
interface Snapshot { production_id: string; application_group_id: string | null; group_name: string | null; component_role: string; members: Member[]; candidates: Member[]; canWrite: boolean }
const roles = [{ value: 'application', label: 'Application' }, { value: 'frontend', label: 'Frontend' }, { value: 'backend', label: 'Backend API' }, { value: 'service', label: 'Service' }]

export function RelatedApplications({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [relatedId, setRelatedId] = useState('')
  const [role, setRole] = useState('application')
  const [relatedRole, setRelatedRole] = useState('application')
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/sites/${projectId}/related`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not load related applications')
    setSnapshot(body); setRole(body.component_role)
  }, [projectId])
  useEffect(() => { setSnapshot(null); setEditing(false); setRelatedId(''); void refresh().catch(error => setError(error.message)) }, [refresh])
  async function save(unlink = false) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/sites/${projectId}/related`, { method: unlink ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        ...(unlink ? {} : { body: JSON.stringify({ relatedProjectId: relatedId, role, relatedRole }) }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not update application group')
      await refresh(); setEditing(false); setRelatedId('')
    } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  return <section className="border-y border-border py-5 space-y-4" aria-label="Related applications">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2"><Layers className="h-4 w-4 shrink-0 text-primary" /><h2 className="text-sm font-semibold break-words">{snapshot?.group_name || 'Related applications'}</h2>{snapshot?.application_group_id && <span className="text-xs text-muted-foreground">Application group</span>}</div>
      {snapshot?.canWrite && <div className="flex flex-wrap gap-2">{snapshot.application_group_id && <Button size="sm" variant="ghost" onClick={() => void save(true)} disabled={busy}><Unlink className="h-4 w-4 mr-2" />Unlink this app</Button>}<Button size="sm" variant="outline" onClick={() => setEditing(!editing)} disabled={busy}><Link2 className="h-4 w-4 mr-2" />Link application</Button></div>}
    </div>
    {error && <p role="alert" className="notice-error">{error}</p>}
    {!snapshot && !error && <Loader2 aria-label="Loading related applications" className="h-4 w-4 animate-spin" />}
    {snapshot && !snapshot.members.length && <p className="text-sm text-muted-foreground">Independent application</p>}
    {snapshot && snapshot.members.length > 0 && <div className="divide-y divide-border">
      {snapshot.members.map(member => {
        const Icon = member.component_role === 'frontend' ? AppWindow : member.component_role === 'backend' ? Server : Layers
        return <div key={member.id} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="flex min-w-0 gap-3"><Icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Link href={`/sites/${member.id}`} className="text-sm font-medium break-words hover:text-primary" aria-current={member.id === projectId ? 'page' : undefined}>{member.name}</Link><span className={'text-[11px] ' + (member.environment === 'staging' ? 'text-amber-300' : 'text-emerald-300')}>{member.environment}</span>{member.id === projectId && <span className="text-[11px] text-muted-foreground">Current</span>}</div><div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{roles.find(role => role.value === member.component_role)?.label}</span><span>{member.project_type}</span><span>{member.default_branch}</span><span>Port {member.port || 'unassigned'}</span><span>{member.database_count} {member.database_count === 1 ? 'database' : 'databases'}</span><span>{member.deployment_status || 'Not deployed'}</span></div></div></div>
          <div className="flex items-center gap-1 pl-6 sm:pl-0">
            <Button asChild size="icon" variant="ghost" title="Databases" aria-label={`Databases for ${member.name}`}><Link href={`/sites/${member.id}?tab=setup&step=database`}><Database className="h-4 w-4" /></Link></Button>
            <Button asChild size="icon" variant="ghost" title="Domains" aria-label={`Domains for ${member.name}`}><Link href={`/sites/${member.id}?tab=setup&step=domain`}><Globe className="h-4 w-4" /></Link></Button>
            <Button asChild size="icon" variant="ghost" title="Environment" aria-label={`Environment for ${member.name}`}><Link href={`/sites/${member.id}?tab=config`}><KeyRound className="h-4 w-4" /></Link></Button>
            <Button asChild size="icon" variant="ghost" title="Console" aria-label={`Console for ${member.name}`}><Link href={`/sites/${member.id}?tab=console`}><Terminal className="h-4 w-4" /></Link></Button>
            {member.url && <Button asChild size="icon" variant="ghost" title="Open application" aria-label={`Open ${member.name}`}><a href={member.url} target="_blank" rel="noreferrer"><ArrowUpRight className="h-4 w-4" /></a></Button>}
          </div>
        </div>
      })}
    </div>}
    {editing && snapshot?.canWrite && <form className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="field-label">Related application<select required className="control-input" value={relatedId} onChange={event => { setRelatedId(event.target.value); setRelatedRole(snapshot.candidates.find(app => app.id === event.target.value)?.component_role || 'application') }}><option value="">Select application</option>{snapshot.candidates.map(app => <option key={app.id} value={app.id}>{app.name} ({app.project_type})</option>)}</select></label>
      <label className="field-label">This app&apos;s role<select className="control-input" value={role} onChange={event => setRole(event.target.value)}>{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
      <label className="field-label">Related app&apos;s role<select className="control-input" value={relatedRole} onChange={event => setRelatedRole(event.target.value)}>{roles.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
      <Button type="submit" disabled={busy || !relatedId}>{busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}Link</Button>
    </form>}
  </section>
}
