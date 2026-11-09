'use client'
import { useState } from 'react'
import { Play,RotateCw,Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { infrastructureResponse } from '@/lib/infrastructure-client'
export function ApplicationProcess({appId,name,serverId,canWrite,onChanged}:{appId:string;name:string;serverId?:string;canWrite:boolean;onChanged?:()=>void}) {
  const [busy,setBusy]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('')
  async function act(action:string){if(action==='stop'&&!window.confirm(`Stop ${name}? Visitors will not be able to reach it until you start it again.`))return;setBusy(action);setMessage('');setError('');try{const endpoint=serverId?`/api/servers/${serverId}/infrastructure/services/${appId}/${action}`:`/api/services/${appId}/${action}`;await infrastructureResponse(await fetch(endpoint,{method:'POST'}),serverId?`/api/servers/${serverId}/infrastructure`:undefined);setMessage(`${action==='start'?'Start':action==='stop'?'Stop':'Restart'} completed.`);onChanged?.()}catch(e){setError((e as Error).message)}finally{setBusy('')}}
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><span className="mr-auto text-sm text-muted-foreground">Process</span>{([{action:'start',label:'Start',Icon:Play},{action:'restart',label:'Restart',Icon:RotateCw},{action:'stop',label:'Stop',Icon:Square}]).map(({action,label,Icon})=><Button key={action} size="sm" variant="outline" disabled={!canWrite||!!busy} onClick={()=>void act(action)}><Icon className="mr-1.5 h-3.5 w-3.5"/>{busy===action?`${label}…`:label}</Button>)}</div>{error&&<p role="alert" className="notice-error">{error}</p>}{message&&<p role="status" className="text-sm text-status-ready">{message}</p>}</div>
}
