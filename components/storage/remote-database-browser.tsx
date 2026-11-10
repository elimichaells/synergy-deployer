'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import Link from 'next/link'
import {useParams,useSearchParams} from 'next/navigation'
import {AppShell} from '@/components/layout/app-shell'
import {Button} from '@/components/ui/button'

type Lease={token:string;url:string;expiresAt:number}
export function RemoteDatabaseBrowser(){
  const {id}=useParams<{id:string}>(),connectionId=useSearchParams().get('connection')||''
  const [lease,setLease]=useState<Lease|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[expired,setExpired]=useState(false)
  const current=useRef<Lease|null>(null),generation=useRef(0)
  const endpoint=`/api/servers/${id}/database-browser`
  const close=useCallback((value:Lease|null)=>{if(value)void fetch(endpoint,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value.token}),keepalive:true}).catch(()=>{})},[endpoint])
  const open=useCallback(async()=>{
    const run=++generation.current;close(current.current);current.current=null;setLease(null);setLoading(true);setError('');setExpired(false)
    try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId})}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not open the database browser');if(run!==generation.current){close(body);return}current.current=body;setLease(body)}catch(error){if(run===generation.current)setError((error as Error).message)}finally{if(run===generation.current)setLoading(false)}
  },[close,connectionId,endpoint])
  const invalidate=useCallback(()=>{generation.current++;close(current.current);current.current=null},[close])
  useEffect(()=>{void open();return invalidate},[open,invalidate])
  useEffect(()=>{if(!lease)return;const timer=setTimeout(()=>{setExpired(true);setLease(null);close(current.current);current.current=null},Math.max(0,lease.expiresAt-Date.now()));return()=>clearTimeout(timer)},[lease,close])
  return <AppShell title="phpMyAdmin" subtitle="Database access on the selected server"><div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Sign in with a database account. This private session lasts 30 minutes. Imports and exports are limited to 8 MB; use Storage or the server’s database tools for larger transfers. Browser preferences and query history are temporary.</p><Button variant="outline" disabled={loading} onClick={()=>void open()}>{loading?'Opening…':'New session'}</Button></div>
    <div className="flex gap-4 text-sm"><Link className="underline" href={`/infrastructure/servers/${id}/storage`}>Back to Storage</Link><Link className="underline" href={`/infrastructure/servers/${id}/runtimes`}>Runtimes & tools</Link></div>
    {error&&<p role="alert" className="notice-error">{error}</p>}{expired&&<p role="status">This database session expired. Open a new session to continue.</p>}
    {lease&&<iframe key={lease.token} title="phpMyAdmin on the selected server" src={lease.url} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" className="h-[78vh] w-full rounded-lg border border-border bg-white"/>}
  </div></AppShell>
}
