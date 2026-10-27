'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { RemoteApp } from '@/lib/managed-server-types'

const inputClass = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
type Connection = { id: string; name: string }

export function RemoteAppForm({ serverId, platform, app, onSaved, onCancel, onDirtyChange }: {
  serverId: string; platform: string; app?: RemoteApp; onSaved: () => void; onCancel: () => void; onDirtyChange?: (dirty: boolean) => void
}) {
  const [form, setForm] = useState({ name: app?.name || '', repo_url: app?.repo_url || '', branch: app?.branch || 'main',
    install_cmd: app?.install_cmd ?? 'npm ci --include=dev', build_cmd: app?.build_cmd ?? 'npm run build', start_cmd: app?.start_cmd || 'npm start -- --hostname 127.0.0.1',
    port: String(app?.port || 3000), health_path: app?.health_path || '/', access_mode: app?.access_mode || 'lan', hostname: app?.hostname || '',
    ip_address: app?.ip_address || '', ip_port: String(app?.ip_port || 8443), git_connection_id: app?.git_connection_id || '' })
  const [environment, setEnvironment] = useState('')
  const initial = useRef(JSON.stringify(form))
  useEffect(() => { onDirtyChange?.(JSON.stringify(form) !== initial.current || environment !== '') }, [form, environment, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const [connections, setConnections] = useState<Connection[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void fetch('/api/git/connections').then(async r => { if (r.ok) setConnections((await r.json()).connections || []) }).catch(() => {}) }, [])
  function field(name: keyof typeof form, value: string) { setForm(current => ({ ...current, [name]: value })) }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const env = environment.trim() ? JSON.parse(environment) : app ? undefined : {}
      const response = await fetch(`/api/servers/${serverId}/apps${app ? `/${app.id}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, environment: env }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save application')
      onSaved()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  function preset(value: string) {
    const commands: Record<string, string[]> = {
      next: ['npm ci --include=dev', 'npm run build', 'npm start -- --hostname 127.0.0.1'],
      node: ['npm ci --include=dev', 'npm run build --if-present', 'npm start'],
      go: ['go mod download', `go build -o ${platform === 'win32' ? 'app.exe' : 'app'} .`, platform === 'win32' ? '.\\app.exe' : './app'],
      laravel: ['composer install --no-dev --optimize-autoloader', 'php artisan config:cache', 'php artisan serve --host=127.0.0.1 --port=' + form.port + ' --no-reload'],
    }
    const values = commands[value]
    if (values) setForm(current => ({ ...current, install_cmd: values[0], build_cmd: values[1], start_cmd: values[2] }))
  }
  return <form onSubmit={save} className="space-y-5 rounded-xl border border-border bg-card p-5">
    <h2 className="font-semibold">{app ? 'Edit remote app' : 'New remote app'}</h2>
    <p className="text-xs leading-5 text-muted-foreground">Commands run on this {platform === 'win32' ? 'Windows' : 'Linux'} server. Required language runtimes must already be installed. Applications and build scripts must be trusted to run as the agent account.</p>
    {error && <p role="alert" className="notice-error">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">App name<input required maxLength={100} className={inputClass} value={form.name} onChange={e => field('name', e.target.value)} /></label>
      <label className="text-sm">Git connection<select className={inputClass} value={form.git_connection_id} onChange={e => field('git_connection_id', e.target.value)}><option value="">Public repository (no credentials)</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="text-sm sm:col-span-2">Repository URL<input type="url" required placeholder="https://github.com/organization/app" className={inputClass} value={form.repo_url} onChange={e => field('repo_url', e.target.value)} /></label>
      <label className="text-sm">Branch<input required className={inputClass} value={form.branch} onChange={e => field('branch', e.target.value)} /></label>
      <label className="text-sm">Command preset<select className={inputClass} defaultValue="" onChange={e => preset(e.target.value)}><option value="">Choose a preset…</option><option value="next">Next.js</option><option value="node">Node.js</option><option value="go">Go</option><option value="laravel">Laravel</option></select></label>
      {(['install_cmd','build_cmd','start_cmd'] as const).map((key,i) => <label key={key} className="text-sm sm:col-span-2">{['Install command','Build command','Start command'][i]}<input required={key === 'start_cmd'} className={`${inputClass} font-mono`} value={form[key]} onChange={e => field(key, e.target.value)} /></label>)}
      <label className="text-sm">Application port<input type="number" min={1024} max={65535} required className={inputClass} value={form.port} onChange={e => field('port', e.target.value)} /></label>
      <label className="text-sm">Health check path<input required className={inputClass} value={form.health_path} onChange={e => field('health_path', e.target.value)} /><span className="mt-1 block text-xs text-muted-foreground">Must return HTTP 2xx without login or redirects.</span></label>
    </div>
    <fieldset className="space-y-4 rounded-lg border border-border p-4"><legend className="px-2 text-sm font-medium">Caddy and access</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Certificate mode<select className={inputClass} value={form.access_mode} onChange={e => field('access_mode', e.target.value)}><option value="lan">LAN — institution network / local CA</option><option value="wan">WAN — public domain / public CA</option></select></label>
        <label className="text-sm">Readable hostname<input required placeholder="library.campus.example.edu" className={inputClass} value={form.hostname} onChange={e => field('hostname', e.target.value)} /></label>
        <label className="text-sm">Optional IP access address<input placeholder="192.168.10.20" className={inputClass} value={form.ip_address} onChange={e => field('ip_address', e.target.value)} /></label>
        {form.ip_address && <label className="text-sm">IP access HTTPS port<input required type="number" min={1024} max={65535} className={inputClass} value={form.ip_port} onChange={e => field('ip_port', e.target.value)} /></label>}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{form.access_mode === 'lan' ? 'Create an internal DNS record pointing this name to the server’s LAN address. Install the server’s public root CA on client devices. Internal HTTPS does not need public DNS or internet access.' : 'Point public DNS to the server or its gateway. Forward TCP 80 and 443 to Caddy and allow outbound certificate issuance. For internal access to the same name, use split DNS or supported hairpin NAT.'}</p>
      <p className="text-xs leading-5 text-muted-foreground">Certificate mode does not restrict who can connect. Scope firewall rules to institution networks for LAN-only apps. Caddy uses ports 80/443, plus the optional IP HTTPS port. Keep backend app ports and admin port 2029 private. IP access always uses the local CA.</p>
    </fieldset>
    <label className="block text-sm">Environment variables (JSON)<textarea rows={5} spellCheck={false} className={`${inputClass} font-mono`} placeholder={'{\n  "DATABASE_URL": "postgres://app:password@db-server:5432/app"\n}'} value={environment} onChange={e => setEnvironment(e.target.value)} /><span className="mt-1 block text-xs leading-5 text-muted-foreground">{app ? `Leave blank to preserve existing values (${app.env_names.join(', ') || 'none'}). Enter {} to clear them. ` : ''}Values are encrypted in Manager. PORT, HOST, HOSTNAME and NODE_ENV are supplied by the agent. Database hostnames must resolve from the target server.</span></label>
    <p className="text-xs leading-5 text-muted-foreground">Each deployment creates a new release directory, then briefly stops the app for activation. Store uploads and other persistent files outside the release directory. Existing database changes are not reversed by an application rollback.</p>
    <div className="flex gap-2"><Button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save app'}</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
  </form>
}
