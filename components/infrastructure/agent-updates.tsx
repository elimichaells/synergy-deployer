'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ManagedServer } from '@/lib/managed-server-types'

type UpdateStatus = {
  installed: string | null; available: string; supported: boolean; updateAvailable: boolean
  latest: null | { id: string; from_version: string; target_version: string; status: string; message: string; updated_at: string }
}
const activeStates = ['queued','installing','recovery_required']
const labels: Record<string,string> = { queued:'Waiting for idle', installing:'Installing & checking', success:'Update complete', rolled_back:'Previous version restored', failed:'Update stopped safely', cancelled:'Update cancelled', recovery_required:'Recovery needs attention' }

export function AgentUpdates({ server, admin, onChanged }: { server: ManagedServer; admin: boolean; onChanged: () => void }) {
  const [data,setData] = useState<UpdateStatus | null>(null)
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [checking,setChecking] = useState(false)
  const load = useCallback(async () => {
    setChecking(true)
    try {
      const response = await fetch(`/api/servers/${server.id}/agent-update`,{cache:'no-store'})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not check agent updates')
      setData(result);setError('')
    } catch(err) { setError((err as Error).message) } finally { setChecking(false) }
  },[server.id])
  useEffect(() => { void load(); const timer = setInterval(() => void load(),5000); return () => clearInterval(timer) },[load])
  async function action(action: 'update' | 'cancel') {
    setBusy(true);setError('')
    try {
      const response = await fetch(`/api/servers/${server.id}/agent-update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id:data?.latest?.id})})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not start agent update')
      await load();onChanged()
    } catch(err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const latest = data?.latest
  const active = !!latest && activeStates.includes(latest.status)
  return <section aria-label="Agent updates" className="rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />Agent updates</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Verified updates from this Manager · Windows & Linux</p></div>
      <Button size="sm" variant="outline" disabled={checking || busy} onClick={() => void load()}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />Check version</Button>
    </div>
    {error && <p role="alert" className="notice-error mt-3">{error}</p>}
    {!data && !error && <p role="status" className="mt-3 text-xs text-muted-foreground">Checking agent version…</p>}
    {data && <>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5">Installed <strong className="ml-1 font-mono">{data.installed ? `v${data.installed}` : 'Not connected'}</strong></span><span className="rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-primary">Available <strong className="ml-1 font-mono">v{data.available}</strong></span>{data.supported && !data.updateAvailable && <span className="flex items-center gap-1.5 text-status-ready"><CheckCircle2 className="h-3.5 w-3.5" />{data.installed === data.available ? 'Up to date' : 'Newer than this Manager'}</span>}</div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">An active deployment finishes first. Queued application jobs wait during the update. Enrollment, application files, databases and Caddy settings stay in place. If the new agent fails its connection or application checks, the previous agent is restored.</p>
      {latest && <div role="status" aria-live="polite" className={`mt-3 rounded-lg border p-3 text-xs ${['rolled_back','failed','recovery_required'].includes(latest.status) ? 'border-status-building/25 bg-status-building/5' : 'border-border bg-muted/30'}`}><p className="font-medium">{labels[latest.status] || latest.status} · v{latest.from_version} → v{latest.target_version}</p><p className="mt-1 leading-5 text-muted-foreground">{latest.message}</p>{active && server.status === 'offline' && <p className="mt-1 leading-5">Waiting for reconnection. Recovery continues locally; closing this page does not cancel it.</p>}{latest.status === 'recovery_required' && <p className="mt-1 leading-5">Inspect the supervisor log and .agent-updates folder on this server before retrying. Application jobs remain paused.</p>}</div>}
      {!data.supported && server.enrolled_at && <details className="mt-3 rounded-lg border border-border bg-muted/20 p-3 text-xs"><summary className="cursor-pointer font-medium">One-time setup needed for this agent</summary><p className="mt-2 leading-5 text-muted-foreground">Older agents cannot install their own first supervisor. Follow the upgrade guide during a maintenance window, using the existing service account and data directory. Keep agent.json, application folders, PM2 data and certificates. Do not enroll the server again.</p><div className="mt-3 flex flex-wrap gap-2">{admin && <><Button asChild size="sm" variant="outline"><a href="/api/servers/agent-update-guide" download="agent-updates.md">Upgrade guide</a></Button><Button asChild size="sm" variant="outline"><a href="/api/servers/agent-supervisor" download="manager-agent-supervisor.cjs"><Download className="mr-1.5 h-3 w-3" />Supervisor</a></Button><Button asChild size="sm" variant="outline"><a href="/api/servers/agent" download="manager-agent.cjs">Agent v{data.available}</a></Button></>}</div></details>}
      {admin && server.enabled && data.supported && <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" disabled={busy || !!error || active || !data.updateAvailable || server.status !== 'online'} onClick={() => void action('update')}><ArrowUpCircle className="mr-1.5 h-3.5 w-3.5" />{busy ? 'Saving…' : 'Update agent'}</Button>{latest?.status === 'queued' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action('cancel')}>Cancel queued update</Button>}{!active && server.status !== 'online' && <span className="text-xs text-muted-foreground">Connect this server before updating.</span>}</div>}
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">The available version is bundled with this Manager. Update Manager to receive newer agent releases. Remote servers need access to Manager only; GitHub access is not required.</p>
    </>}
  </section>
}
