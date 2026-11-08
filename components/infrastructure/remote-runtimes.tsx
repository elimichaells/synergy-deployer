'use client'
import { useRef,useState } from 'react'
import { RuntimeManager } from '@/components/runtime-manager'
import type { ManagedServer } from '@/lib/managed-server-types'
import { RemoteServices,type RequestedService } from './remote-services'

export function RemoteRuntimes({server,fresh,admin,onChanged}:{server:ManagedServer;fresh:boolean;admin:boolean;onChanged:()=>void}){
  const [requested,setRequested]=useState<RequestedService>(),[revision,setRevision]=useState(0),form=useRef<HTMLDivElement>(null)
  return <div className="space-y-6">{!fresh&&<p className="text-xs text-muted-foreground">Last reported inventory. Connect this server before changing application runtime versions.</p>}
    <RuntimeManager key={revision} isAdmin={admin} workspace endpoint={`/api/servers/${server.id}/runtimes`} onRequestOperation={(runtime,action,version)=>{
      setRequested({service:runtime.id,mode:action==='install-version'||action==='update'?'install-version':action==='configure'?'reuse':'install',version:version||'',nonce:Date.now()});form.current?.scrollIntoView({behavior:'smooth',block:'start'})
    }}/>
    {admin&&server.enrolled_at&&server.enabled&&<div ref={form}><RemoteServices server={server} requested={requested} onChanged={()=>{setRevision(r=>r+1);onChanged()}}/></div>}
  </div>
}
