'use client'

import {useEffect,useRef,useState} from 'react'
import {Zap} from 'lucide-react'
import {Switch} from '@/components/ui/switch'
import {cn} from '@/lib/utils'

/** The same quick action on local and connected-server application/project pages. */
export function AutoDeployControl({appId,serverId,name,branch,enabled,disabled=false,variant='header',label,onChanged}:{
  appId:string;serverId?:string;name:string;branch:string;enabled:boolean;disabled?:boolean
  variant?:'header'|'compact'|'switch';label?:string;onChanged?:(enabled:boolean)=>void
}){
  const [value,setValue]=useState(enabled),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const pending=useRef<AbortController|null>(null)
  useEffect(()=>setValue(enabled),[enabled])
  useEffect(()=>{setError('');setBusy(false);setValue(enabled);return()=>{pending.current?.abort();pending.current=null}},[appId,serverId]) // eslint-disable-line react-hooks/exhaustive-deps
  async function change(next:boolean){
    if(disabled||pending.current)return
    const controller=new AbortController();pending.current=controller;setBusy(true);setError('')
    try{
      const response=await fetch(serverId?`/api/servers/${serverId}/apps/${appId}/git-automation`:`/api/sites/${appId}`,{
        method:serverId?'POST':'PATCH',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify(serverId?{action:'auto',enabled:next}:{autoDeploy:next})
      })
      const body=await response.json();if(!response.ok)throw Error(body.error||'Could not change automatic deployments')
      if(controller.signal.aborted)return
      const saved=typeof body.autoDeploy==='boolean'?body.autoDeploy:typeof body.auto_deploy==='boolean'?body.auto_deploy:next
      setValue(saved);onChanged?.(saved)
    }catch(error){if(!controller.signal.aborted)setError((error as Error).message)}
    finally{if(pending.current===controller){pending.current=null;setBusy(false)}}
  }
  return <div className="flex flex-col gap-1">
    <label className={cn('flex items-center gap-2 text-xs text-muted-foreground',variant==='header'&&'rounded-md border border-border px-3 py-1.5')} title={value?`Deploys when you push to ${branch}`:'Pushes are ignored; deploy manually'}>
      {variant!=='switch'&&<><Zap className={cn('h-3.5 w-3.5',value&&'text-status-ready')} aria-hidden="true"/>Auto-deploy</>}
      <Switch checked={value} disabled={disabled||busy} onCheckedChange={next=>void change(next)} aria-label={label||`Auto-deploy ${name}`}/>
      {busy&&<span role="status">{value?'Saving…':'Connecting webhook…'}</span>}
    </label>
    {error&&<p role="alert" className="max-w-md text-xs text-status-failed">{error}</p>}
  </div>
}
