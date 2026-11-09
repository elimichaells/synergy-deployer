'use client'
import { useState } from 'react'
import { Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription } from '@/components/ui/sheet'
import { RuntimeManager } from '@/components/runtime-manager'
import type { ManagedServer } from '@/lib/managed-server-types'
import { RemoteServices,type RequestedService } from './remote-services'

export function RemoteRuntimes({server,fresh,admin,onChanged}:{server:ManagedServer;fresh:boolean;admin:boolean;onChanged:()=>void}){
  const [requested,setRequested]=useState<RequestedService>(),[revision,setRevision]=useState(0), [open,setOpen]=useState(false)
  return <div className="space-y-6">{!fresh&&<p className="text-xs text-muted-foreground">Last reported inventory. Connect this server before changing application runtime versions.</p>}
    <RuntimeManager key={server.id+':'+revision} isAdmin={admin} workspace endpoint={`/api/servers/${server.id}/runtimes`} onRequestOperation={(runtime,action,version)=>{
      setRequested({service:runtime.id,mode:action==='install-version'||action==='update'?'install-version':action==='configure'?'reuse':'install',version:version||'',nonce:Date.now()});setOpen(true)
    }}/>
    {admin&&server.enrolled_at&&server.enabled&&<Sheet open={open} onOpenChange={setOpen}><SheetContent className="w-full overflow-y-auto sm:max-w-2xl"><SheetHeader><SheetTitle>Configure runtime on {server.name}</SheetTitle><SheetDescription>Inspect existing installations and review changes on this server.</SheetDescription></SheetHeader><div className="mt-6"><RemoteServices key={server.id} server={server} requested={requested} onChanged={()=>{setRevision(r=>r+1);onChanged()}}/></div></SheetContent></Sheet>}
  </div>
}
