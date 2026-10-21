'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

interface Connection { id: string; name: string; provider: string; base_url: string; ca_pem?: string; account_login: string; project_count: number; last_error?: string; token_last_four: string }
const empty = { name: '', provider: 'gitlab', baseUrl: '', token: '', caPem: '' }
export function SelfHostedGit({ isAdmin }: { isAdmin: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [form, setForm] = useState(empty)
  const [editing, setEditing] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => {
    const response = await fetch('/api/git/connections'); const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not load connections')
    setConnections(data.connections.filter((row: Connection) => row.provider !== 'github'))
  }
  useEffect(() => { void load().catch(error => setMessage(error.message)) }, [])
  const perform = async (url: string, method: string, body?: unknown) => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Git connection request failed')
      await load(); setForm(empty); setEditing(null); setOpen(false); setMessage(method === 'DELETE' ? 'Connection removed.' : 'Connection verified and saved.')
    } catch (error) { setMessage((error as Error).message) } finally { setBusy(false) }
  }
  return <div className="space-y-4 border-t border-border pt-6">
    <div className="flex items-center justify-between gap-4"><div><h3 className="text-sm font-semibold">Self-hosted Git</h3><p className="mt-1 text-xs text-muted-foreground">Connect your institution’s GitLab or Gitea server over HTTPS.</p></div>
      {isAdmin && <Button size="sm" variant="outline" onClick={() => { setEditing(null); setForm(empty); setOpen(true); setMessage('') }}>Add connection</Button>}</div>
    {connections.map(row => <div key={row.id} className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{row.name} · {row.provider === 'gitlab' ? 'GitLab' : 'Gitea'}</p><p className="break-all text-xs text-muted-foreground">{row.base_url} · {row.account_login} · {row.project_count} applications</p><p className="text-xs text-muted-foreground">Token ending {row.token_last_four}</p>{row.last_error && <p className="text-xs text-red-400">{row.last_error}</p>}</div>
      {isAdmin && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(`/api/git/connections/${row.id}/test`, 'POST')}>Test</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditing(row.id); setForm({ name: row.name, provider: row.provider, baseUrl: row.base_url, token: '', caPem: row.ca_pem || '' }); setOpen(true) }}>Edit</Button>
        <Button size="sm" variant="ghost" disabled={busy || row.project_count > 0} onClick={() => { if (window.confirm(`Remove ${row.name}?`)) void perform(`/api/git/connections/${row.id}`, 'DELETE') }}>Remove</Button></>}
    </div>)}
    {open && isAdmin && <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); void perform('/api/git/connections' + (editing ? '/' + editing : ''), editing ? 'PATCH' : 'POST', form) }}>
      <div className="grid gap-3 sm:grid-cols-2"><label className="field-label">Connection name<input required maxLength={80} className="control-input" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
        <label className="field-label">Provider<select disabled={!!editing} className="control-input" value={form.provider} onChange={event => setForm({ ...form, provider: event.target.value })}><option value="gitlab">GitLab</option><option value="gitea">Gitea</option></select></label></div>
      <label className="field-label">Server address<input required disabled={!!editing} type="url" className="control-input" placeholder="https://git.institution.edu" value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} /></label>
      <label className="field-label">{editing ? 'Replacement access token (leave blank to keep)' : 'Access token'}<input required={!editing} type="password" autoComplete="new-password" className="control-input" value={form.token} onChange={event => setForm({ ...form, token: event.target.value })} /></label>
      <p className="text-xs text-muted-foreground">{form.provider === 'gitlab' ? 'Use a GitLab personal access token with read_api and read_repository. Automatic webhook setup needs api and a Maintainer role; promotion needs write_repository.' : 'Use a Gitea access token with read:user and repository access. Automatic webhook setup and promotion need repository write access.'} Use an account authorized for the repositories you intend to deploy.</p>
      <label className="field-label">Institutional CA certificates (optional)<textarea rows={4} className="control-input font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" value={form.caPem} onChange={event => setForm({ ...form, caPem: event.target.value })} /></label>
      <p className="text-xs text-muted-foreground">Paste public CA certificates if the Git server uses an institutional certificate. Tokens are encrypted on the deployer and remain available after a restart.</p>
      <div className="flex gap-2"><Button disabled={busy} type="submit">{busy ? 'Verifying…' : 'Verify and save'}</Button><Button disabled={busy} variant="ghost" type="button" onClick={() => { setOpen(false); setForm(empty) }}>Cancel</Button></div>
    </form>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
