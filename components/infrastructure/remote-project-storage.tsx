'use client'

import {useCallback,useEffect,useState} from 'react'
import {usePathname,useRouter,useSearchParams} from 'next/navigation'
import Link from 'next/link'
import {Database,Plus} from 'lucide-react'
import {Section} from '@/components/app/section'
import {ProviderLogo,providerMeta,type Provider} from '@/components/app/providers'
import {ProjectServiceSheet} from '@/components/app/project-service-sheet'
import {Button} from '@/components/ui/button'
import {useStorageTransport} from '@/lib/storage-client'
import type {RemoteApp} from '@/lib/managed-server-types'
import {remoteAppHref} from '@/lib/remote-workspace'

type Service={id:string;project_id:string;database_name:string;name:string;provider:Provider;connection_name:string;status:string;application_primary:boolean;backup_frequency?:string;backup_status?:string;options:{sharedFrom?:string}}
export function RemoteProjectStorage({serverId,projectName,apps,canWrite,onChanged}:{serverId:string;projectName:string;apps:RemoteApp[];canWrite:boolean;onChanged:()=>void}){
  const {fetch}=useStorageTransport(),params=useSearchParams(),router=useRouter(),pathname=usePathname(),requested=params.get('addService')==='1'
  const [services,setServices]=useState<Service[]>([]),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[open,setOpen]=useState(requested)
  useEffect(()=>{if(requested)setOpen(true)},[requested])
  const changeOpen=(value:boolean)=>{setOpen(value);if(!value&&requested){const next=new URLSearchParams(params);next.delete('addService');router.replace(`${pathname}?${next}#applications`,{scroll:false})}}
  const load=useCallback(async(signal?:AbortSignal)=>{
    try{const response=await fetch('/api/data/services',{cache:'no-store',signal}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not load project databases');if(signal?.aborted)return;setServices(body.services||[]);setLoaded(true);setError('')}
    catch(error){if(!signal?.aborted)setError((error as Error).message)}
  },[fetch])
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort()},[load])
  const ids=new Set(apps.map(app=>app.id)),visible=services.filter(item=>ids.has(item.project_id)),owned=visible.filter(item=>!item.options?.sharedFrom)
  const appName=(id:string)=>apps.find(app=>app.id===id)?.name||'Application'
  return <>
    <Section title="Databases & services" description="Each database belongs to one app, which manages its password and backups, and can be shared with the other apps here." action={<Button size="sm" disabled={!canWrite||!loaded||!!error} onClick={()=>setOpen(true)}><Plus className="mr-1.5 h-4 w-4"/>Add service</Button>}>
      {error&&<p role="alert" className="notice-error">{error}<Button variant="ghost" onClick={()=>void load()}>Retry</Button></p>}
      {notice&&<p role="status" className="mb-4 text-sm text-status-ready">{notice}</p>}
      {!loaded&&!error?<p role="status" className="text-sm text-muted-foreground">Loading databases…</p>:owned.length?<div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{owned.map(service=><div key={service.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5"><ProviderLogo provider={service.provider}/><div className="min-w-0 flex-1"><p className="truncate font-mono text-sm font-medium">{service.database_name}</p><p className="text-xs text-muted-foreground">{providerMeta[service.provider]?.label} on {service.connection_name} · {service.status}{service.backup_frequency?` · ${service.backup_frequency} backups${service.backup_status?` (${service.backup_status})`:''}`:''}</p></div><div className="flex flex-wrap gap-1.5">{[service,...visible.filter(item=>item.options?.sharedFrom===service.id)].map((item,index)=><span key={item.id} className="rounded-full border border-border px-2 py-px text-[11px]">{appName(item.project_id)}{index===0?' · owner':''}</span>)}</div><Button asChild size="sm" variant="ghost"><Link href={remoteAppHref(serverId,service.project_id,'storage')}>Manage</Link></Button></div>)}</div>:!error&&<div className="rounded-lg border border-dashed border-border px-4 py-10 text-center"><Database className="mx-auto mb-2 h-5 w-5 text-muted-foreground"/><p className="text-sm font-medium">No databases yet</p><p className="mt-1 text-xs text-muted-foreground">Add a service or reuse an existing database on this server.</p><Button size="sm" className="mt-4" disabled={!canWrite||!loaded} onClick={()=>setOpen(true)}>Add service</Button></div>}
    </Section>
    <ProjectServiceSheet open={open&&canWrite&&loaded&&!error} onOpenChange={changeOpen} projectName={projectName} apps={apps.map(app=>({id:app.id,name:app.name,component_role:app.component_role||'standalone',project_type:app.project_type||'node',environment:app.environment_name||'production'}))} appsWithMainDatabase={visible.filter(item=>item.application_primary).map(item=>item.project_id)} role={canWrite?'admin':'viewer'} onCreated={message=>{setNotice(message);void load();onChanged()}}/>
  </>
}
