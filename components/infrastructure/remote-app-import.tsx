'use client'

import { useEffect, useState } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChoiceCard } from '@/components/app/section'
import type { ManagedServer } from '@/lib/managed-server-types'
import { REMOTE_SETUP_CAPABILITY } from '@/lib/remote-setup-policy'

type Repo = { name: string; fullName: string; cloneUrl: string; defaultBranch: string; private: boolean }
export function RemoteAppImport({ server, onCreated, onCancel, onDirtyChange }: { server: ManagedServer; onCreated: (id: string) => void; onCancel: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [connections,setConnections]=useState<{id:string;name:string}[]>([])
  const [repos,setRepos]=useState<Repo[]>([]), [search,setSearch]=useState('')
  const [form,setForm]=useState({name:'',repo_url:'',git_connection_id:'',branch:'main',stagingBranch:'develop',environmentMode:'production-staging'})
  const [busy,setBusy]=useState(false), [loading,setLoading]=useState(false), [error,setError]=useState('')
  const capable=server.metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY)
  useEffect(()=>{void fetch('/api/git/connections').then(async response=>{if(!response.ok)throw new Error('Could not load Git connections');setConnections((await response.json()).connections || [])}).catch(error=>setError(error.message))},[])
  useEffect(()=>{onDirtyChange(!!form.name || !!form.repo_url);return ()=>onDirtyChange(false)},[form.name,form.repo_url,onDirtyChange])
  useEffect(()=>{
    setRepos([]); if(!form.git_connection_id)return
    const abort=new AbortController();setLoading(true)
    void fetch(`/api/git/repos?connectionId=${encodeURIComponent(form.git_connection_id)}`,{signal:abort.signal}).then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error || 'Could not load repositories');setRepos(result.repos || [])}).catch(error=>{if(error.name!=='AbortError')setError(error.message)}).finally(()=>{if(!abort.signal.aborted)setLoading(false)})
    return ()=>abort.abort()
  },[form.git_connection_id])
  async function create(event: React.FormEvent) {
    event.preventDefault();setBusy(true);setError('')
    try {
      const response=await fetch(`/api/servers/${server.id}/apps/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)})
      const result=await response.json();if(!response.ok)throw new Error(result.error || 'Could not import application')
      onDirtyChange(false);onCreated(result.id)
    } catch(error){setError((error as Error).message)} finally{setBusy(false)}
  }
  return <form onSubmit={create} className="mx-auto max-w-3xl space-y-6 rounded-xl border border-border bg-card p-5 sm:p-6">
    <div><p className="eyebrow">Import a repository</p><h2 className="text-xl font-semibold">Configure your app</h2><p className="mt-1 text-sm text-muted-foreground">Synergy clones and detects your app on {server.name}, then guides you through build settings, database, environment and HTTPS.</p></div>
    {!capable && <div role="alert" className="notice-error">This server needs agent 1.1.0 or later for guided setup. Download the current agent from Server access, replace the installed script and restart its agent service. Existing applications keep running.</div>}
    {error && <p role="alert" className="notice-error">{error}</p>}
    <fieldset disabled={busy || !capable} className="space-y-5">
      <label className="field-label">Git connection<select className="control-input" value={form.git_connection_id} onChange={event=>setForm({...form,git_connection_id:event.target.value})}><option value="">Public repository</option>{connections.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {form.git_connection_id && <div className="space-y-2"><label className="field-label">Find a repository<input className="control-input" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search by repository name" /></label>{loading?<p className="text-xs text-muted-foreground">Loading repositories…</p>:<div className="max-h-48 overflow-y-auto rounded-lg border border-border">{repos.filter(repo=>repo.fullName.toLowerCase().includes(search.toLowerCase())).map(repo=><button type="button" key={repo.fullName} onClick={()=>setForm({...form,name:repo.name,repo_url:repo.cloneUrl,branch:repo.defaultBranch})} className="flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2.5 text-left text-sm last:border-0 hover:bg-accent"><span className="truncate">{repo.fullName}</span><span className="text-xs text-muted-foreground">{repo.private?'Private':'Public'}</span></button>)}</div>}</div>}
      <label className="field-label">Repository URL<input type="url" required className="control-input" value={form.repo_url} placeholder="https://github.com/organization/app" onChange={event=>setForm({...form,repo_url:event.target.value})} /></label>
      <div className="grid gap-4 sm:grid-cols-2"><label className="field-label">Application name<input required maxLength={100} className="control-input" value={form.name} onChange={event=>setForm({...form,name:event.target.value})} /></label><label className="field-label">{form.environmentMode==='staging'?'Staging':'Production'} branch<input required className="control-input font-mono" value={form.branch} onChange={event=>setForm({...form,branch:event.target.value})} /></label></div>
      <div><p className="mb-3 text-sm font-medium">Environments</p><div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Environments">{[['production','Production only','One production application.'],['staging','Staging only','A test application, with no production copy.'],['production-staging','Production + Staging','Separate ports, databases, secrets and releases.']].map(([value,title,description])=><ChoiceCard key={value} title={title} description={description} selected={form.environmentMode===value} onSelect={()=>setForm({...form,environmentMode:value})} />)}</div></div>
      {form.environmentMode==='production-staging' && <label className="field-label max-w-sm">Staging branch<input required className="control-input font-mono" value={form.stagingBranch} onChange={event=>setForm({...form,stagingBranch:event.target.value})} /></label>}
    </fieldset>
    <p className="text-xs leading-5 text-muted-foreground">Each environment has its own guided setup. Importing inspects source without running application scripts or replacing a live release.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !capable} type="submit">{busy?<Loader2 className="mr-2 h-4 w-4 animate-spin" />:<GitBranch className="mr-2 h-4 w-4" />}Import and set up</Button><Button disabled={busy} type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
  </form>
}
