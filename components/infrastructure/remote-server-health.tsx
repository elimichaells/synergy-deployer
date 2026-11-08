'use client'
import { useEffect,useState } from 'react'
import { HealthWorkspace } from './health-workspace'
import type { ServerHealth } from '@/lib/server-health-types'
import type { ManagedServer,RemoteApp } from '@/lib/managed-server-types'
import { ProcessesWorkspace } from './processes-workspace'
export function RemoteServerHealth({server}:{server:ManagedServer;apps:RemoteApp[];fresh:boolean}){
 const [health,setHealth]=useState<ServerHealth|null>(null),[error,setError]=useState(false)
 const endpoint=`/api/servers/${server.id}/infrastructure/health`
 useEffect(()=>{let cancelled=false;const controller=new AbortController();setHealth(null);async function load(){try{const r=await fetch(endpoint,{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error();const data=await r.json();if(!cancelled){setHealth(data);setError(false)}}catch{if(!cancelled)setError(true)}}void load();const timer=setInterval(()=>void load(),30000);return()=>{cancelled=true;controller.abort();clearInterval(timer)}},[endpoint])
 return <HealthWorkspace health={health} error={error} remoteEndpoint={endpoint}/>
}
export function RemoteProcesses({server}:{server:ManagedServer;apps:RemoteApp[];fresh:boolean}){return <ProcessesWorkspace key={server.id} serverId={server.id}/>}
