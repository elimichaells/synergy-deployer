'use client'
import { useCallback, useEffect, useState } from 'react'
import { EnvEditor } from '@/components/env-editor'
import { Section } from './section'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/layout/workspace-provider'

export function EnvironmentSettings({projectId,serverId,canWrite,browserApp,onDirtyChange,onSaved}:{projectId:string;serverId?:string;canWrite:boolean;browserApp?:boolean;onDirtyChange?:(dirty:boolean)=>void;onSaved?:()=>void}) {
  const {navigate}=useWorkspace()
  const [file,setFile]=useState('.env'),[content,setContent]=useState(''),[baseline,setBaseline]=useState(''),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false)
  const endpoint=serverId?`/api/servers/${serverId}/apps/${projectId}/env`:`/api/sites/${projectId}/env`
  useEffect(()=>{onDirtyChange?.(content!==baseline);return()=>onDirtyChange?.(false)},[content,baseline,onDirtyChange])
  const load=useCallback(async(signal:AbortSignal)=>{
    setLoaded(false);setError('');setSaved(false)
    try{const response=await fetch(`${endpoint}?file=${encodeURIComponent(file)}`,{cache:'no-store',signal}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not load environment file');if(!signal.aborted){setContent(body.content||'');setBaseline(body.content||'');setLoaded(true)}}catch(error){if(!signal.aborted)setError((error as Error).message)}
  },[endpoint,file])
  useEffect(()=>{const controller=new AbortController();if(canWrite)void load(controller.signal);return()=>controller.abort()},[load,canWrite])
  async function save(){setBusy(true);setError('');try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file,content,previousContent:baseline})}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not save environment file');setBaseline(content);setSaved(true);onSaved?.()}catch(error){setError((error as Error).message)}finally{setBusy(false)}}
  return <Section title="Environment variables" description={<>Save these settings before deploying. Every deployment reads the saved <span className="font-mono text-xs">.env</span> and <span className="font-mono text-xs">.env.local</span>; .env.local takes precedence for Node apps. Managed database connections provide standard variables automatically.</>}
    action={<div className="flex h-8 items-center rounded-md border border-border p-0.5" role="group" aria-label="File">{['.env','.env.local'].map(value=><button key={value} type="button" disabled={busy} aria-pressed={file===value} onClick={()=>{if(file!==value)navigate(()=>{setContent('');setBaseline('');setFile(value)})}} className={`h-full rounded-[5px] px-2.5 font-mono text-xs ${file===value?'bg-white/[0.09] text-foreground':'text-muted-foreground hover:text-foreground'}`}>{value}</button>)}</div>}
    footer={<><span>{browserApp?'Browser builds expose these values to visitors. Never store secrets here.':serverId?'Stored encrypted by Manager and written to this application on deployment.':'Stored inside the application directory on this server.'}</span><Button size="sm" onClick={()=>void save()} disabled={!loaded||busy||!canWrite}>{busy?'Saving…':saved?'Saved':'Save'}</Button></>}>
    {error&&<p role="alert" className="notice-error mb-3">{error}</p>}
    {canWrite?<EnvEditor className="h-[28rem]" value={content} disabled={!loaded||busy} onChange={value=>{setContent(value);setSaved(false)}} placeholder={`# ${file}\nKEY=value`}/>:<p className="text-sm text-muted-foreground">An administrator or operator can view and edit environment values.</p>}
  </Section>
}
