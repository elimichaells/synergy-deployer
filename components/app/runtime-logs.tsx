'use client'
import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/app/section'
import { scopedInfrastructureFetch } from '@/lib/infrastructure-client'

export function RuntimeLogs({projectId,serverId,canWrite,unavailable}:{projectId:string;serverId?:string;canWrite:boolean;unavailable?:string}) {
  const [type,setType]=useState<'out'|'err'>('out'),[log,setLog]=useState(''),[logPath,setLogPath]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[auto,setAuto]=useState(true),[revision,setRevision]=useState(0),[clearing,setClearing]=useState(false)
  const endpoint=`/api/sites/${projectId}/logs?type=${type}`
  const scope=useRef('');scope.current=`${serverId||'host'}:${endpoint}`
  const stopRead=useRef<()=>void>(()=>{})
  useEffect(()=>{setLog('');setLogPath('');setError('');setClearing(false)},[serverId,endpoint])
  useEffect(()=>{
    if(unavailable)return
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined,stream:EventSource|undefined
    const controller=new AbortController()
    const stop=()=>{cancelled=true;controller.abort();stream?.close();if(timer)clearTimeout(timer)}
    stopRead.current=stop
    const receive=(body:{log?:string;logPath?:string})=>{if(!cancelled){setLog(body.log||'');setLogPath(body.logPath||'');setError('');setBusy(false)}}
    const read=async()=>{if(cancelled)return;setBusy(true);try{const response=await scopedInfrastructureFetch(serverId,endpoint,{cache:'no-store',signal:controller.signal}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not read application logs');receive(body)}catch(e){if(!cancelled)setError((e as Error).message)}finally{if(!cancelled){setBusy(false);if(auto)timer=setTimeout(()=>void read(),15000)}}}
    if(!serverId&&auto){setBusy(true);stream=new EventSource(`/api/sites/${projectId}/logs/stream?type=${type}&lines=200`);stream.onmessage=event=>{try{receive(JSON.parse(event.data))}catch{}};stream.onerror=()=>{stream?.close();void read()}}else void read()
    return stop
  },[endpoint,projectId,type,serverId,auto,revision,unavailable])
  async function clear(){if(!window.confirm(`Clear this application's ${type==='out'?'output':'error'} log? This cannot be undone.`))return;const current=scope.current;stopRead.current();setClearing(true);setBusy(true);setError('');try{const response=await scopedInfrastructureFetch(serverId,endpoint,{method:'DELETE'}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not clear logs');if(scope.current===current)setLog('')}catch(e){if(scope.current===current)setError((e as Error).message)}finally{if(scope.current===current){setClearing(false);setBusy(false);setRevision(n=>n+1)}}}
  return <Section title="Logs" description={<>What the app prints while it runs. When something is not working, look here first.{logPath&&<> · <span className="break-all font-mono text-xs">{logPath}</span></>}</>} action={<>
    <div className="flex h-8 items-center rounded-md border border-border p-0.5" role="group" aria-label="Log stream">{(['out','err'] as const).map(value=><button key={value} type="button" disabled={clearing} onClick={()=>{setType(value);setLog('');setLogPath('')}} aria-pressed={type===value} className={`h-full rounded-[5px] px-2.5 text-xs ${type===value?'bg-white/[0.09] text-foreground':'text-muted-foreground hover:text-foreground'}`}>{value==='out'?'Output':'Errors'}</button>)}</div>
    <Button variant="outline" size="sm" disabled={busy||!!unavailable} onClick={()=>setRevision(n=>n+1)}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy?'animate-spin':''}`}/>Refresh</Button><Button variant="outline" size="sm" disabled={busy||!canWrite||!!unavailable} onClick={()=>void clear()}>Clear</Button>
  </>}>
    <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" disabled={clearing} checked={auto} onChange={e=>setAuto(e.target.checked)}/>Refresh automatically{serverId?' · every 15 seconds':''}</label>
    {(error||unavailable)&&<p role="alert" className="notice-error mb-3">{unavailable||error}</p>}
    <div className="h-[520px] overflow-auto rounded-lg border border-border bg-well p-4 font-mono text-xs leading-5"><pre className="whitespace-pre-wrap break-words">{log||(busy?'Reading logs…':'No output yet. Logs appear once the app is running.')}</pre></div>
  </Section>
}
