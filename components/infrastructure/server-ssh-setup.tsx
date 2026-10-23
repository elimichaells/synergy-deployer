'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

const input = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function ServerSshSetup({ serverId, platform, onConnected, onBusyChange }: { serverId: string; platform: string; onConnected: () => void; onBusyChange: (busy: boolean) => void }) {
  const [form, setForm] = useState({ host: '', port: '22', username: platform === 'win32' ? 'Administrator' : '', password: '', manager: '', caPem: '' })
  const [fingerprint, setFingerprint] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState<'probe' | 'setup' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ online: boolean; message: string; log: string } | null>(null)
  useEffect(() => setForm(current => ({ ...current, manager: window.location.origin })), [])
  function field(key: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [key]: value }))
    if (['host','port','username'].includes(key)) { setFingerprint(''); setAccepted(false) }
  }
  async function submit(action: 'probe' | 'setup') {
    setBusy(action); setError(''); setResult(null)
    onBusyChange(true)
    const payload = action === 'probe' ? { action, host: form.host, port: form.port, username: form.username } : { action, ...form, fingerprint, acceptFingerprint: accepted }
    if (action === 'setup') setForm(current => ({ ...current, password: '' }))
    try {
      const response = await fetch(`/api/servers/${serverId}/ssh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'SSH setup failed')
      if (action === 'probe') { setFingerprint(body.fingerprint); setAccepted(false) }
      else { setResult(body); onConnected() }
    } catch (err) { setError((err as Error).message) } finally { setBusy(null); onBusyChange(false) }
  }
  return <section className="space-y-4 rounded-xl border border-border bg-card p-5" aria-label="Connect with SSH">
    <h2 className="font-semibold">Connect with SSH</h2>
    <p className="text-sm leading-6 text-muted-foreground">Enter the server address and login. Manager installs the agent and tools and configures startup. Your SSH password is used once and is not saved.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Server IP or hostname<input disabled={!!busy} className={input} placeholder="192.168.10.20" value={form.host} onChange={e => field('host', e.target.value)} /></label>
      <label className="text-sm">SSH port<input disabled={!!busy} className={input} type="number" min={1} max={65535} value={form.port} onChange={e => field('port', e.target.value)} /></label>
      <label className="text-sm">SSH username<input disabled={!!busy} className={input} autoComplete="off" value={form.username} onChange={e => field('username', e.target.value)} /></label>
      <label className="text-sm">SSH password<input disabled={!!busy} className={input} type="password" autoComplete="new-password" value={form.password} onChange={e => field('password', e.target.value)} /></label>
      <label className="text-sm sm:col-span-2">Manager HTTPS address reachable from this server<input disabled={!!busy} className={input} type="url" placeholder="https://manager.example.edu" value={form.manager} onChange={e => field('manager', e.target.value)} /></label>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{platform === 'win32' ? 'Requires Windows OpenSSH Server and an administrator login.' : 'Requires SSH and root or sudo access with this password.'} Manager must be able to reach the SSH port.</p>
    <details className="text-sm"><summary className="cursor-pointer">What setup installs</summary><p className="mt-2 text-xs leading-5 text-muted-foreground">Setup installs Node.js, Git, PM2 and Caddy from their official sources. It needs internet access and stops if an existing agent or web server occupies the required paths or ports. {platform === 'win32' ? 'Windows uses portable tools in ProgramData and a startup task running under Local Service.' : 'Linux supports systemd with apt or dnf, on x64 or ARM64, and uses a dedicated manager-agent service account.'} Firewall, DNS and databases are separate setup steps. Servers behind a gateway may need a VPN or port forwarding for SSH.</p></details>
    <details className="text-sm"><summary className="cursor-pointer">Private Manager certificate</summary><p className="mt-2 text-xs leading-5 text-muted-foreground">The Manager installer’s local CA is included automatically when available. For a different institutional CA, paste its public PEM certificate below. Private keys are not accepted.</p><label className="mt-3 block text-xs">Optional Manager root CA<textarea disabled={!!busy} rows={4} className={`${input} font-mono`} value={form.caPem} onChange={e => field('caPem', e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></label></details>
    {error && <p role="alert" className="notice-error">{error}</p>}
    {!result && <Button variant="outline" disabled={!!busy || !form.host || !form.username} onClick={() => void submit('probe')}>{busy === 'probe' ? 'Checking SSH…' : 'Check server identity'}</Button>}
    {fingerprint && !result && <div className="space-y-3 rounded-lg border border-border p-4"><p className="text-xs text-muted-foreground">SSH host fingerprint — compare with the fingerprint provided by the server administrator:</p><p className="break-all font-mono text-xs">{fingerprint}</p><label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={!!busy} checked={accepted} onChange={e => setAccepted(e.target.checked)} />I recognize this server and approve installing the agent and prerequisites.</label><Button disabled={!!busy || !accepted || !form.password || !form.manager.startsWith('https://')} onClick={() => void submit('setup')}>{busy === 'setup' ? 'Installing and connecting…' : 'Install and connect'}</Button></div>}
    {busy === 'setup' && <p role="status" className="text-sm leading-6 text-muted-foreground">Installing tools, enrolling the agent and starting its service. This can take several minutes. Keep this page open; deployments and monitoring will use the outbound agent connection after setup.</p>}
    {result && <div className="space-y-3"><p role="status" className={result.online ? 'text-sm text-emerald-300' : 'text-sm text-amber-200'}>{result.message}</p><details><summary className="cursor-pointer text-sm">Setup log</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words bg-black/30 p-3 text-xs">{result.log}</pre></details></div>}
  </section>
}
