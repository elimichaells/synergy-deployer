'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Cloud, Globe2, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { CloudflareTokenGuide } from '@/components/cloudflare-token-guide'
import { LanAccessFields } from '@/components/app/lan-access-fields'

interface User { id: string; name: string; role: string }
interface Project { id: string; name: string; environment: string; port: number | null }
interface Connection { id: string; name: string; token_last_four: string; token_status: string; last_error: string | null; domain_count: number }
interface Zone { id: string; name: string; status: string; paused: boolean; connection_id: string; connection_name: string }
interface Domain { application_route?:boolean;operation_status?:string;operation_log?:string; id: string; project_id: string; project_name: string; environment: string; hostname: string; cloudflare_connection_id: string; cloudflare_connection_name: string; cloudflare_zone_id: string; record_type: string; record_content: string; proxied: boolean; is_primary: boolean; ssl_mode: string | null; dns_status: string; ssl_status: string; last_error: string | null }

const inputClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring'

function EmbeddedWorkspace({children}:{children:React.ReactNode;[key:string]:unknown}){return <>{children}</>}

export function DomainsWorkspace({serverId}:{serverId?:string}) {
  const endpoint=serverId?`/api/servers/${serverId}/domains`:'/api/domains'
  const Shell=serverId?EmbeddedWorkspace:AppShell
  const [user, setUser] = useState<User | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [domainOpen, setDomainOpen] = useState(false)
  const [connectionForm, setConnectionForm] = useState({ name: '', token: '' })
  const [domainForm, setDomainForm] = useState({ projectId: '', cloudflareConnectionId: '', hostname: '', lanIp:'',lanPort:'8443',recordType: 'A', recordContent: '', proxied: true, isPrimary: true, mode:'lan' })

  const refresh = useCallback(async () => {
    setNotice(null)
    try {
      const [meResponse, projectsResponse, connectionsResponse, domainsResponse] = await Promise.all([fetch('/api/auth/me'),fetch(serverId?`/api/servers/${serverId}`:'/api/sites'),fetch('/api/cloudflare/connections'),fetch(endpoint)])
      const meBody=await meResponse.json(); const projectBody=projectsResponse.ok ? await projectsResponse.json() : []
      const connectionsBody=connectionsResponse.ok ? await connectionsResponse.json() : {connections:[]}
      setUser(meBody.user || null); setProjects(Array.isArray(projectBody) ? projectBody : serverId?(projectBody.apps||[]).map((a:any)=>({...a,environment:a.environment_name||'production',port:a.live_commit?a.port:null})):projectBody.projects || []); setConnections(connectionsBody.connections || []); setDomains(domainsResponse.ok ? (await domainsResponse.json()).domains || [] : [])
      if (connectionsBody.connections?.length) {
        const zonesResponse=await fetch('/api/cloudflare/zones')
        if (zonesResponse.ok) setZones((await zonesResponse.json()).zones || [])
      } else setZones([])
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Failed to load domain management') }
    finally { setLoading(false) }
  }, [endpoint,serverId])
  useEffect(() => { void refresh() }, [refresh])
  const isAdmin=user?.role === 'admin'
  const selectedConnectionZones=useMemo(() => zones.filter((zone) => zone.connection_id === domainForm.cloudflareConnectionId),[zones,domainForm.cloudflareConnectionId])

  const addConnection=async()=>{setBusy('connection');setNotice(null);setConnectionError(null);try{const response=await fetch('/api/cloudflare/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(connectionForm)});const body=await response.json();if(!response.ok)throw new Error(body.error||'Unable to connect Cloudflare');setConnectionOpen(false);setConnectionForm({name:'',token:''});await refresh();setNotice('Cloudflare token verified and stored securely.')}catch(error){setConnectionError(error instanceof Error?error.message:'Unable to connect Cloudflare')}finally{setBusy(null)}}
  const testConnection=async(id:string)=>{setBusy(`test-${id}`);try{const response=await fetch(`/api/cloudflare/connections/${id}/test`,{method:'POST'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Token test failed');await refresh();setNotice('Cloudflare token is active.')}catch(error){setNotice(error instanceof Error?error.message:'Token test failed');await refresh()}finally{setBusy(null)}}
  const removeConnection=async(connection:Connection)=>{if(!window.confirm(`Remove Cloudflare connection "${connection.name}"?`))return;setBusy(`connection-${connection.id}`);try{const response=await fetch(`/api/cloudflare/connections/${connection.id}`,{method:'DELETE'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Unable to remove connection');await refresh()}catch(error){setNotice(error instanceof Error?error.message:'Unable to remove connection')}finally{setBusy(null)}}
  const addDomain=async()=>{setBusy('domain');setNotice(null);try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(domainForm)});const body=await response.json();if(!response.ok)throw new Error(body.error||'Domain setup failed');setDomainOpen(false);setDomainForm({...domainForm,hostname:'',recordContent:''});await refresh();setNotice(domainForm.mode==='lan'?'LAN HTTPS route loaded. Trust this server’s public root certificate on client devices.':'Address configured and the selected server confirmed its proxy routes.')}catch(error){setNotice(error instanceof Error?error.message:'Domain setup failed')}finally{setBusy(null)}}
  const syncDomain=async(id:string)=>{setBusy(`sync-${id}`);try{const response=await fetch(`${endpoint}/${id}`,{method:'PATCH'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Sync failed');await refresh()}catch(error){setNotice(error instanceof Error?error.message:'Sync failed')}finally{setBusy(null)}}
  const removeDomain=async(domain:Domain)=>{if(!window.confirm(`Remove ${domain.hostname} from ${domain.cloudflare_connection_id ? "Cloudflare DNS and Caddy" : "Caddy? The manual DNS record will be retained"}?`))return;setBusy(`domain-${domain.id}`);try{const response=await fetch(`${endpoint}/${domain.id}`,{method:'DELETE'});const body=await response.json();if(!response.ok)throw new Error(body.error||'Unable to remove domain');await refresh()}catch(error){setNotice(error instanceof Error?error.message:'Unable to remove domain')}finally{setBusy(null)}}
  const setStrict=async(zone:Zone)=>{if(!window.confirm(`Set the entire ${zone.name} zone to Full (strict) SSL? The origin must have a valid certificate.`))return;setBusy(`ssl-${zone.id}`);try{const response=await fetch(`/api/cloudflare/zones/${zone.id}/ssl`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:zone.connection_id,mode:'strict'})});const body=await response.json();if(!response.ok)throw new Error(body.error||'SSL update failed');await refresh();setNotice(`${zone.name} now uses Full (strict) SSL.`)}catch(error){setNotice(error instanceof Error?error.message:'SSL update failed')}finally{setBusy(null)}}

  const actions=isAdmin?<><Button variant="outline" size="sm" onClick={()=>setConnectionOpen(true)}><Cloud className="mr-2 h-4 w-4"/>Connect Cloudflare</Button><Button size="sm" onClick={()=>setDomainOpen(true)}><Plus className="mr-2 h-4 w-4"/>Add domain</Button></>:undefined
  return <Shell area="infrastructure" title="Domains & DNS" subtitle="Public domains and private LAN addresses on this server." user={user || undefined} actions={actions}>
    <div className="space-y-6">
      {serverId&&<div className="flex flex-wrap justify-end gap-2">{actions}</div>}
      {notice&&<div className="rounded-md border border-border bg-muted/50 px-4 py-3 text-sm">{notice}</div>}
      <section><div className="mb-3 flex items-center justify-between"><div><h2 className="text-sm font-semibold">Cloudflare connections</h2><p className="text-xs text-muted-foreground">Scoped access to selected zones for DNS records and SSL settings.</p></div><Button variant="ghost" size="sm" onClick={()=>void refresh()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading?'animate-spin':''}`}/></Button></div><div className="grid gap-3 lg:grid-cols-2">{connections.map(connection=><Card key={connection.id}><CardHeader className="pb-3"><div className="flex items-start justify-between"><div><CardTitle className="text-sm">{connection.name}</CardTitle><CardDescription>Token ending in {connection.token_last_four}</CardDescription></div><Badge variant={connection.token_status==='active'?'secondary':'destructive'} className={connection.token_status==='active'?'bg-emerald-500/15 text-emerald-300':''}>{connection.token_status}</Badge></div></CardHeader><CardContent className="flex items-center justify-between"><p className="text-xs text-muted-foreground">{connection.domain_count} managed domain{connection.domain_count===1?'':'s'}</p>{isAdmin&&<div className="flex gap-1"><Button variant="ghost" size="sm" onClick={()=>void testConnection(connection.id)} disabled={!!busy}>{busy===`test-${connection.id}`?<Loader2 className="h-4 w-4 animate-spin"/>:<><CheckCircle2 className="mr-2 h-4 w-4"/>Test</>}</Button><Button variant="ghost" size="sm" title="Remove connection" onClick={()=>void removeConnection(connection)} disabled={!!busy||connection.domain_count>0}><Trash2 className="h-4 w-4"/></Button></div>}</CardContent></Card>)}{!connections.length&&<div className="col-span-full border-y border-border py-10 text-center text-sm text-muted-foreground">Cloudflare is optional. Use a private LAN IP or your own DNS provider without connecting an account.</div>}</div></section>
      {!!zones.length&&<section><div className="mb-3"><h2 className="text-sm font-semibold">Zones</h2><p className="text-xs text-muted-foreground">SSL mode is zone-wide. Full (strict) is recommended after Caddy has obtained an origin certificate.</p></div><div className="overflow-x-auto border-y border-border"><table className="w-full min-w-[680px] text-sm"><thead className="bg-muted/40 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3">Zone</th><th className="px-4 py-3">Connection</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">SSL</th></tr></thead><tbody className="divide-y divide-border">{zones.map(zone=>{const managed=domains.filter(domain=>domain.cloudflare_zone_id===zone.id);const strict=managed.some(domain=>domain.ssl_mode==='strict');return <tr key={`${zone.connection_id}-${zone.id}`}><td className="px-4 py-3 font-medium">{zone.name}</td><td className="px-4 py-3 text-muted-foreground">{zone.connection_name}</td><td className="px-4 py-3 capitalize">{zone.status}{zone.paused?' · paused':''}</td><td className="px-4 py-3 text-right">{strict?<Badge variant="secondary" className="bg-emerald-500/15 text-emerald-300"><ShieldCheck className="mr-1 h-3 w-3"/>Full (strict)</Badge>:isAdmin?<Button variant="outline" size="sm" onClick={()=>void setStrict(zone)} disabled={!!busy}>{busy===`ssl-${zone.id}`?<Loader2 className="h-4 w-4 animate-spin"/>:'Set Full (strict)'}</Button>:<span className="text-xs text-muted-foreground">Not verified</span>}</td></tr>})}</tbody></table></div></section>}
      <section><div className="mb-3"><h2 className="text-sm font-semibold">Managed application domains</h2><p className="text-xs text-muted-foreground">Application hostnames and their assigned proxy routes.</p></div><div className="overflow-x-auto border-y border-border"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Hostname</th><th className="px-4 py-3">Application</th><th className="px-4 py-3">DNS</th><th className="px-4 py-3">Proxy</th><th className="px-4 py-3">SSL</th><th className="w-24 px-4 py-3"/></tr></thead><tbody className="divide-y divide-border">{domains.map(domain=><tr key={domain.id}><td className="px-4 py-3"><a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">{domain.hostname}</a>{domain.is_primary&&<p className="text-[11px] text-cyan-300">Primary</p>}</td><td className="px-4 py-3"><p>{domain.project_name}</p><p className="text-xs capitalize text-muted-foreground">{domain.environment}</p></td><td className="px-4 py-3"><p className="font-mono text-xs">{domain.record_type} {domain.record_content}</p><p className="text-xs text-muted-foreground">{domain.dns_status}{domain.operation_status?` · route ${domain.operation_status}`:''}</p>{domain.last_error&&<p className="mt-1 max-w-xs text-xs text-destructive">{domain.last_error}</p>}</td><td className="px-4 py-3">{domain.dns_status==='lan'?'Institution LAN':domain.proxied?'Cloudflare':'DNS only'}</td><td className="px-4 py-3"><Badge variant={domain.ssl_mode==='strict'?'secondary':'outline'} className={domain.ssl_mode==='strict'?'bg-emerald-500/15 text-emerald-300':''}>{domain.dns_status==='lan'?'Local CA':domain.ssl_mode||domain.ssl_status||'pending'}</Badge></td><td className="px-4 py-3"><div className="flex">{domain.application_route&&<a className="text-xs underline" href={`/infrastructure/servers/${serverId}?tab=domains#app-${domain.project_id}`}>Manage</a>}<Button variant="ghost" size="sm" title={domain.cloudflare_connection_id ? "Sync Cloudflare status" : "Manual DNS record"} onClick={()=>void syncDomain(domain.id)} disabled={!!busy || !!domain.application_route || (!serverId&&!domain.cloudflare_connection_id)}><RefreshCw className={`h-4 w-4 ${busy===`sync-${domain.id}`?'animate-spin':''}`}/></Button>{isAdmin&&!domain.application_route&&<Button variant="ghost" size="sm" title="Remove domain" onClick={()=>void removeDomain(domain)} disabled={!!busy}><Trash2 className="h-4 w-4"/></Button>}</div></td></tr>)}{!domains.length&&<tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No application domains are managed yet.</td></tr>}</tbody></table></div></section>
    </div>
    <Sheet open={connectionOpen} onOpenChange={open=>{setConnectionOpen(open);setConnectionError(null)}}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader><SheetTitle>Connect Cloudflare</SheetTitle><SheetDescription>The API token is verified, encrypted, and never returned by the API.</SheetDescription></SheetHeader>
        <form className="mt-6 grid gap-4" onSubmit={event=>{event.preventDefault();if(busy!=='connection')void addConnection()}}>
          <CloudflareTokenGuide />
          <label className="grid gap-2 text-sm">Connection name<input required className={inputClass} value={connectionForm.name} onChange={e=>setConnectionForm({...connectionForm,name:e.target.value})} placeholder="Production Cloudflare"/></label>
          <label className="grid gap-2 text-sm">Scoped API token
            <input required className={inputClass} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="cloudflare-token-hint" value={connectionForm.token} onChange={e=>setConnectionForm({...connectionForm,token:e.target.value})}/>
            <span id="cloudflare-token-hint" className="text-xs text-muted-foreground">Paste only the token value, without Bearer, quotes, or a curl command.</span>
          </label>
          {connectionError&&<p role="alert" className="break-words text-sm text-destructive">{connectionError}</p>}
          <Button type="submit" disabled={busy==='connection'||!connectionForm.name.trim()||!connectionForm.token.trim()}>{busy==='connection'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Cloud className="mr-2 h-4 w-4"/>}Verify and connect</Button>
        </form>
      </SheetContent>
    </Sheet>
    <Sheet open={domainOpen} onOpenChange={setDomainOpen}><SheetContent className="overflow-y-auto">
      <SheetHeader><SheetTitle>Add application address</SheetTitle><SheetDescription>Use a private LAN IP or connect a public domain. Existing applications keep their routes.</SheetDescription></SheetHeader>
      <form className="mt-6 grid gap-4" onSubmit={event=>{event.preventDefault();void addDomain()}}>
        <label className="field-label">Application<select required className={inputClass} value={domainForm.projectId} onChange={e=>setDomainForm({...domainForm,projectId:e.target.value})}><option value="">Select application</option>{projects.map(project=><option key={project.id} value={project.id} disabled={!project.port}>{project.name} · {project.environment}{!project.port?' (deploy first)':''}</option>)}</select></label>
        <label className="field-label">Address type<select className={inputClass} value={domainForm.mode} onChange={e=>setDomainForm({...domainForm,mode:e.target.value})}><option value="lan">Institution LAN / private IP</option><option value="manual">Public domain / existing DNS</option><option value="cloudflare">Public domain / Cloudflare</option></select></label>
        {domainForm.mode==='lan'?<LanAccessFields ip={domainForm.lanIp} port={domainForm.lanPort} serverId={serverId} onChange={value=>setDomainForm({...domainForm,...value})}/>:<>
          {domainForm.mode==='cloudflare'&&<label className="field-label">Cloudflare connection<select required className={inputClass} value={domainForm.cloudflareConnectionId} onChange={e=>setDomainForm({...domainForm,cloudflareConnectionId:e.target.value})}><option value="">Select connection</option>{connections.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>}
          {domainForm.mode==='cloudflare'&&domainForm.cloudflareConnectionId&&<p className="text-xs text-muted-foreground">Accessible zones: {selectedConnectionZones.map(zone=>zone.name).join(', ')||'none detected'}</p>}
          <label className="field-label">Hostname<input required className={inputClass} value={domainForm.hostname} onChange={e=>setDomainForm({...domainForm,hostname:e.target.value})} placeholder="app.example.com"/></label>
          <div className="grid grid-cols-[7rem_1fr] gap-3"><label className="field-label">Record<select className={inputClass} value={domainForm.recordType} onChange={e=>setDomainForm({...domainForm,recordType:e.target.value})}><option>A</option><option>AAAA</option><option>CNAME</option></select></label><label className="field-label">Target<input required className={inputClass} value={domainForm.recordContent} onChange={e=>setDomainForm({...domainForm,recordContent:e.target.value})} placeholder={domainForm.recordType==='A'?'203.0.113.10':domainForm.recordType==='AAAA'?'2001:db8::10':'origin.example.com'}/></label></div>
          {domainForm.mode==='cloudflare'&&<label className="flex items-center justify-between border-y border-border py-3 text-sm"><span>Cloudflare proxy</span><Switch checked={domainForm.proxied} onCheckedChange={checked=>setDomainForm({...domainForm,proxied:checked})}/></label>}
        </>}
        <label className="flex items-center justify-between border-b border-border pb-3 text-sm"><span>Primary application address</span><Switch checked={domainForm.isPrimary} onCheckedChange={checked=>setDomainForm({...domainForm,isPrimary:checked})}/></label>
        {notice&&<p role="alert" className="text-sm text-destructive">{notice}</p>}
        <Button type="submit" disabled={busy==='domain'||!domainForm.projectId||(domainForm.mode==='cloudflare'&&!domainForm.cloudflareConnectionId)||(domainForm.mode==='lan'?!domainForm.lanIp||!domainForm.lanPort:!domainForm.hostname||!domainForm.recordContent)}>{busy==='domain'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<Globe2 className="mr-2 h-4 w-4"/>}Add address</Button>
      </form>
    </SheetContent></Sheet>
  </Shell>
}
