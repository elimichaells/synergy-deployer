'use client'

import { Button } from '@/components/ui/button'
import { ImportFields, type ImportValues } from '@/components/workspace/import-fields'
import { RepositoryPicker, type RepositoryOption } from '@/components/workspace/repository-picker'
import { repositoryPath, repositoryUrl, type GitProvider } from '@/lib/git-provider-policy'
import type { ManagedServer } from '@/lib/managed-server-types'
import { REMOTE_SETUP_CAPABILITY } from '@/lib/remote-setup-policy'
import { ArrowLeft, ArrowRight, GitBranch, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

export function RemoteAppImport({ server, onCreated, onCancel, onDirtyChange }: { server: ManagedServer; onCreated: (id: string) => void; onCancel: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [connections, setConnections] = useState<{id:string;name:string;provider:GitProvider;base_url:string;account_login:string}[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [repos, setRepos] = useState<RepositoryOption[]>([]), [search, setSearch] = useState(''), [urlInput, setUrlInput] = useState('')
  const [configuring, setConfiguring] = useState<RepositoryOption | null>(null)
  const [form, setForm] = useState<ImportValues>({name:'',branch:'main',stagingBranch:'staging',environmentMode:'production'})
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const capable = server.enabled && server.metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY)
  useEffect(() => {
    const abort = new AbortController()
    void fetch('/api/git/connections', { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load Git connections')
      const list = (await response.json()).connections || []; setConnections(list); setConnectionId(list[0]?.id || '')
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message) })
    return () => abort.abort()
  }, [])
  useEffect(() => { onDirtyChange(!!configuring); return () => onDirtyChange(false) }, [configuring, onDirtyChange])
  useEffect(() => {
    setRepos([]); if (!connectionId) { setLoading(false); return }
    const abort = new AbortController(); setLoading(true)
    void fetch(`/api/git/repos?connectionId=${encodeURIComponent(connectionId)}`, {signal:abort.signal}).then(async response => {
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load repositories'); setRepos(result.repos || [])
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [connectionId])
  function choose(repo: RepositoryOption) { setConfiguring(repo); setForm(current => ({...current,name:repo.name,branch:repo.defaultBranch})); setError('') }
  function importUrl() {
    try {
      const cloneUrl = repositoryUrl(urlInput.trim()), fullName = repositoryPath(cloneUrl, connections.find(item => item.id === connectionId) || {provider:'github',base_url:'https://github.com'})
      choose({name:fullName.split('/').at(-1)!,fullName,cloneUrl,defaultBranch:'main',private:false})
    } catch (error) { setError((error as Error).message) }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!configuring) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/servers/${server.id}/apps/import`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,repo_url:configuring.cloneUrl,git_connection_id:connectionId})})
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not import application')
      onDirtyChange(false); onCreated(result.id)
    } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  return <>
    {!capable && <div role="alert" className="notice-error">This server needs a connected agent with guided setup support. <Link className="underline" href={`/infrastructure/servers/${server.id}#server-access`}>Open Infrastructure to connect or update it.</Link></div>}
    {error && <p role="alert" className="notice-error">{error}</p>}
    {configuring ? <div className="mx-auto max-w-3xl">
      <button disabled={busy} onClick={() => setConfiguring(null)} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Choose a different repository</button>
      <form onSubmit={create} className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-well px-6 py-5"><span className="flex h-9 w-9 items-center justify-center rounded-full border border-border"><GitBranch /></span><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">Importing from Git</p><p className="truncate font-medium">{configuring.fullName}</p></div><span className="rounded-full border border-border px-2.5 py-1 font-mono text-xs">{form.branch}</span></div>
        <fieldset disabled={busy || !capable} className="space-y-8 p-6">
          <ImportFields value={form} onChange={patch => setForm({...form,...patch})} />
          <div className="grid gap-3 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground sm:grid-cols-3"><p><span className="block font-medium text-foreground">Framework</span>Detected after cloning</p><p><span className="block font-medium text-foreground">Port</span>Assigned automatically</p><p><span className="block font-medium text-foreground">Deployments</span>Started manually</p></div>
          <p className="text-xs leading-5 text-muted-foreground">Each app has its own database, domain and environment settings on {server.name}. Each environment is configured separately.</p>
        </fieldset>
        <div className="border-t border-border px-6 py-4"><Button type="submit" className="h-10 w-full" disabled={busy || !capable || !form.name.trim() || !form.branch.trim()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{busy ? 'Creating…' : <>Continue to setup<ArrowRight className="ml-2 h-4 w-4" /></>}</Button></div>
      </form>
    </div> : <RepositoryPicker connections={connections} connectionId={connectionId} onConnectionChange={setConnectionId} repos={repos} search={search} onSearchChange={setSearch} loading={loading} canCreate={!!capable} onImportRepo={choose} urlInput={urlInput} onUrlChange={setUrlInput} onImportUrl={importUrl} />}
    <Button className="mt-4" disabled={busy} variant="ghost" onClick={onCancel}>Cancel import</Button>
  </>
}
