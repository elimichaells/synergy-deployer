'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Cloud, Globe2, Loader2, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

interface Domain { id: string; hostname: string; dns_status: string; ssl_status: string; record_content: string; cloudflare_connection_id: string | null }
export function ProjectDomains({ projectId, port, canManage, onChanged }: { projectId: string; port: number | null; canManage: boolean; onChanged: () => void }) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [connections, setConnections] = useState<{ id: string; name: string }[]>([])
  const [form, setForm] = useState({ mode: 'manual', hostname: '', cloudflareConnectionId: '', recordType: 'A', recordContent: '', proxied: true, isPrimary: true })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState(false)
  const load = useCallback(async () => {
    try {
      const [domainRes, connectionRes] = await Promise.all([fetch('/api/domains?project=' + projectId), fetch('/api/cloudflare/connections')])
      if (!domainRes.ok || !connectionRes.ok) throw new Error('Could not load domain configuration')
      setDomains((await domainRes.json()).domains || []); setConnections((await connectionRes.json()).connections || [])
    } catch (err) { setError((err as Error).message) }
  }, [projectId])
  useEffect(() => { void load() }, [load])
  const apply = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, projectId }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Domain configuration failed')
      setReview(false); setForm(current => ({ ...current, hostname: '' })); await load(); onChanged()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return <div className="space-y-6">
    {error && <div role="alert" className="notice-error">{error}</div>}
    {domains.length > 0 && <div className="divide-y divide-border border-y border-border">{domains.map(domain => <div key={domain.id} className="flex flex-wrap justify-between gap-3 py-4"><div className="min-w-0"><a href={'https://' + domain.hostname} target="_blank" rel="noreferrer" className="flex items-center gap-2 break-all text-sm font-medium">{domain.hostname}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" /></a><p className="mt-1 text-xs text-muted-foreground">{domain.cloudflare_connection_id ? 'Cloudflare' : 'Manual DNS'} / DNS: {domain.dns_status} / TLS: {domain.ssl_status}</p></div><Link href="/domains" className="text-xs text-primary">Manage</Link></div>)}</div>}
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); setReview(true) }}>
      <fieldset disabled={!canManage || busy || review} className="space-y-5 disabled:opacity-60">
        <div className="flex border-b border-border" role="tablist" aria-label="Domain configuration mode">{[['manual', 'Manual DNS', Globe2], ['cloudflare', 'Cloudflare', Cloud]].map(([mode, label, Icon]) => {
          const ModeIcon = Icon as typeof Globe2
          return <button key={String(mode)} type="button" role="tab" aria-selected={form.mode === mode} onClick={() => setForm({ ...form, mode: String(mode) })} className={'inline-tab flex items-center gap-2 ' + (form.mode === mode ? 'inline-tab-active' : '')}><ModeIcon className="h-4 w-4" />{String(label)}</button>
        })}</div>
        <label className="field-label">Hostname<input required className="control-input" value={form.hostname} onChange={event => setForm({ ...form, hostname: event.target.value })} placeholder="api.example.com" /></label>
        {form.mode === 'cloudflare' && <label className="field-label">Cloudflare connection<select required className="control-input" value={form.cloudflareConnectionId} onChange={event => setForm({ ...form, cloudflareConnectionId: event.target.value })}><option value="">Select connection</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select><Link href="/domains" className="text-xs text-primary">Manage Cloudflare connections</Link></label>}
        <div className="grid gap-4 sm:grid-cols-[110px_minmax(0,1fr)]"><label className="field-label">Record type<select className="control-input" value={form.recordType} onChange={event => setForm({ ...form, recordType: event.target.value })}>{['A', 'AAAA', 'CNAME'].map(type => <option key={type}>{type}</option>)}</select></label><label className="field-label">{form.recordType === 'CNAME' ? 'Target hostname' : 'Server public IP'}<input required className="control-input" value={form.recordContent} onChange={event => setForm({ ...form, recordContent: event.target.value })} placeholder={form.recordType === 'CNAME' ? 'origin.example.com' : form.recordType === 'AAAA' ? '2001:db8::1' : '203.0.113.10'} /></label></div>
        {form.mode === 'cloudflare' && <label className="flex items-center justify-between text-sm">Cloudflare proxy<Switch checked={form.proxied} onCheckedChange={proxied => setForm({ ...form, proxied })} /></label>}
        <label className="flex items-center justify-between text-sm">Primary application domain<Switch checked={form.isPrimary} onCheckedChange={isPrimary => setForm({ ...form, isPrimary })} /></label>
        <Button variant="outline" type="submit" disabled={!canManage}><Globe2 className="mr-2 h-4 w-4" />Review domain changes</Button>
      </fieldset>
      {review && <section aria-label="Domain change review" className="border-y border-amber-400/30 py-5 space-y-4">
        <h3 className="text-sm font-semibold">Confirm domain configuration</h3>
        <dl className="summary-list"><div><dt>DNS record</dt><dd className="break-all">{form.recordType} {form.hostname} &rarr; {form.recordContent}</dd></div><div><dt>DNS change</dt><dd>{form.mode === 'manual' ? 'None. Create the record at your DNS provider.' : 'Create a Cloudflare record'}</dd></div><div><dt>Caddy route</dt><dd>127.0.0.1:{port}</dd></div><div><dt>TLS</dt><dd>Caddy automatic HTTPS; certificate pending DNS reachability</dd></div><div><dt>Cloudflare SSL setting</dt><dd>Unchanged</dd></div></dl>
        <div className="flex flex-wrap gap-2"><Button type="button" onClick={() => void apply()} disabled={busy}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe2 className="mr-2 h-4 w-4" />}Apply domain configuration</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setReview(false)}>Back</Button></div>
      </section>}
      {!canManage && <p className="text-xs text-amber-300">An administrator must apply domain changes.</p>}
    </form>
  </div>
}
