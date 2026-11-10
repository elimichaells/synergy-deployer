'use client'
import { DeploymentScript } from '@/components/app/deployment-script'
import { RemoteAddressFields } from './remote-address-fields'

import { RemoteRuntimeSelection } from './remote-runtime-selection'
import { useEffect, useRef, useState } from 'react'
import { Section } from '@/components/app/section'
import { EnvEditor } from '@/components/env-editor'
import { environmentText, parseEnvironmentText } from '@/lib/environment-text'
import { Button } from '@/components/ui/button'
import type { RemoteApp } from '@/lib/managed-server-types'

const inputClass = 'control-input mt-1'
type Connection = { id: string; name: string }

export function RemoteAppForm({ serverId, platform, app, onSaved, onDirtyChange, section = 'settings', canWrite = true }: {
  section?: 'settings' | 'environment' | 'domains'; canWrite?: boolean; serverId: string; platform: string; app: RemoteApp; onSaved: () => void; onDirtyChange?: (dirty: boolean) => void
}) {
  const appId = app.id
  const [form, setForm] = useState({ runtime_versions:app.runtime_versions||{} as Record<string,string>,name: app?.name || '', repo_url: app?.repo_url || '', branch: app?.branch || 'main',
    install_cmd: app?.install_cmd ?? 'npm ci --include=dev', build_cmd: app?.build_cmd ?? 'npm run build', start_cmd: app?.start_cmd || 'npm start -- --hostname 127.0.0.1',
    deploy_script:app?.deploy_script||'', pre_deploy_cmd:app?.pre_deploy_cmd||'',post_deploy_cmd:app?.post_deploy_cmd||'',
    port: String(app?.port || 3000), health_path: app?.health_path || '/', access_mode: app?.access_mode || 'lan', hostname: app?.hostname || '',
    ip_address: app?.ip_address || '', ip_port: String(app?.ip_port || 8443), git_connection_id: app?.git_connection_id || '' })
  const [environment, setEnvironment] = useState('')
  const [envLoaded, setEnvLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const initialEnv = useRef('')
  const initial = useRef(JSON.stringify(form))
  useEffect(() => { onDirtyChange?.(JSON.stringify(form) !== initial.current || environment !== initialEnv.current) }, [form, environment, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const [connections, setConnections] = useState<Connection[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void fetch('/api/git/connections').then(async r => { if (r.ok) setConnections((await r.json()).connections || []) }).catch(() => {}) }, [])
  useEffect(() => {
    if (section !== 'environment' || !canWrite) return
    const abort = new AbortController()
    void fetch(`/api/servers/${serverId}/apps/${appId}/environment`, { cache: 'no-store', signal: abort.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load environment variables')
      initialEnv.current = environmentText(result.environment)
      setEnvironment(initialEnv.current); setEnvLoaded(true)
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message) })
    return () => abort.abort()
  }, [section, serverId, appId, canWrite])
  function field(name: keyof typeof form, value: string) { setForm(current => ({ ...current, [name]: value })) }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!canWrite) return; setBusy(true); setError(''); setSaved(false)
    try {
      if (section === 'environment' && !envLoaded) throw new Error('Wait for environment variables to load')
      const env = section === 'environment' ? parseEnvironmentText(environment) : undefined
      const response = await fetch(`/api/servers/${serverId}/apps${app ? `/${app.id}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, health_path: app ? undefined : form.health_path, environment: env }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save application')
      initial.current = JSON.stringify(form); initialEnv.current = environment
      onDirtyChange?.(false); setSaved(true); onSaved()
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
  return <form onSubmit={save} className="space-y-6">
    {error && <p role="alert" className="notice-error">{error}</p>}
    {saved && <p role="status" className="text-sm text-status-ready">Changes saved. Deploy the application to apply them.</p>}
    <Section title={section === 'environment' ? 'Environment variables' : section === 'domains' ? 'Domains' : 'Application settings'} description={section === 'environment' ? 'Settings and secrets used by this application.' : section === 'domains' ? 'Configure the address that opens this application.' : 'Name, repository and commands for this application.'}>
    <fieldset disabled={busy || !canWrite} className="space-y-5">
    {section === 'settings' && <>
    <RemoteRuntimeSelection serverId={serverId} value={form.runtime_versions} onChange={runtime_versions=>setForm(f=>({...f,runtime_versions}))}/>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">App name<input required maxLength={100} className={inputClass} value={form.name} onChange={e => field('name', e.target.value)} /></label>
      <label className="text-sm">Git connection<select className={inputClass} value={form.git_connection_id} onChange={e => field('git_connection_id', e.target.value)}><option value="">Public repository (no credentials)</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="text-sm sm:col-span-2">Repository URL<input type="url" required placeholder="https://github.com/organization/app" className={inputClass} value={form.repo_url} onChange={e => field('repo_url', e.target.value)} /></label>
      <label className="text-sm">Branch<input required className={inputClass} value={form.branch} onChange={e => field('branch', e.target.value)} /></label>
      <label className="text-sm">Command preset<select className={inputClass} defaultValue="" onChange={e => preset(e.target.value)}><option value="">Choose a preset…</option><option value="next">Next.js</option><option value="node">Node.js</option><option value="go">Go</option><option value="laravel">Laravel</option></select></label>
      <div className="sm:col-span-2"><DeploymentScript value={form.deploy_script} onChange={value=>field('deploy_script',value)}/></div>
      {(['install_cmd','build_cmd','start_cmd'] as const).map((key,i) => <label key={key} className="text-sm sm:col-span-2">{['Install command','Build command','Start command'][i]}<input required={key === 'start_cmd'} className={`${inputClass} font-mono`} value={form[key]} onChange={e => field(key, e.target.value)} /></label>)}
      <label className="text-sm">Application port<input type="number" min={1024} max={65535} required className={inputClass} value={form.port} onChange={e => field('port', e.target.value)} /></label>
      {!app && <label className="text-sm">Health check path<input required className={inputClass} value={form.health_path} onChange={e => field('health_path', e.target.value)} /><span className="mt-1 block text-xs text-muted-foreground">Uses the application readiness settings. The default accepts HTTP 2xx and local redirects.</span></label>}
    </div>
    </>}
    {section === 'domains' && <RemoteAddressFields value={form} serverId={serverId} onChange={value=>setForm(current=>({...current,...value}))}/>}
    {section === 'environment' && (canWrite ? <EnvEditor className="h-[340px]" value={environment} disabled={!envLoaded || busy} onChange={setEnvironment} /> : <p className="text-sm text-muted-foreground">{app?.env_names.length || 0} variables configured. An administrator can edit their values.</p>)}

    </fieldset>
    {canWrite && <div className="mt-5 flex gap-2"><Button disabled={busy || (section === 'environment' && !envLoaded)} type="submit">{busy ? 'Saving…' : 'Save changes'}</Button></div>}
    </Section>
  </form>
}
