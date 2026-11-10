'use client'
import {useCallback} from 'react'
import {usePathname} from 'next/navigation'
import {serverScope,serverOverview} from './server-navigation'
import {infrastructureResponse,infrastructureAppHref} from './infrastructure-client'
import {storageRead} from './storage-request-queue'

/** Every shared Storage screen keeps the server selected by its URL. */
export async function scopedStorageFetch(serverId:string|undefined,url:string,init?:RequestInit){
  if(!serverId||url==='/api/auth/me')return fetch(url,init)
  const routes:[string,string][]=[['/api/storage','databases'],['/api/data','data'],['/api/sites','apps']]
  if(url.startsWith('/api/system/runtimes'))return fetch(`/api/servers/${serverId}/runtimes${url.slice('/api/system/runtimes'.length)}`,init)
  const route=routes.find(([prefix])=>url===prefix||url.startsWith(prefix+'/')||url.startsWith(prefix+'?'))
  if(!route)throw Error('This storage request has no remote-server destination')
  const review=/^\/api\/storage\/[^/]+\/(?:rename|move|dedicated-user)$/.test(url)&&(!init?.method||init.method==='GET')
  const readAgent=/^\/api\/storage\/[^/]+\/(?:data(?:\/rows)?|stats|backups)(?:\?|$)/.test(url)&&(!init?.method||init.method==='GET')
  const perform=async()=>{
    const signal=review||readAgent?undefined:init?.signal
    const response=await fetch(`/api/servers/${serverId}/storage/${route[1]}${url.slice(route[0].length)}`,review?{...init,signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preview:true})}:readAgent?{...init,signal,method:'POST'}:init)
    if(!response.ok)return{status:response.status,body:await response.json().catch(()=>({error:'Storage request failed'}))}
    try{return{status:200,body:await infrastructureResponse(response,`/api/servers/${serverId}/infrastructure`,signal||undefined,1800000)}}
    catch(error){return{status:409,body:{error:(error as Error).message}}}
  }
  const result=review||readAgent?await storageRead(serverId,url,perform):await perform()
  if(init?.signal?.aborted)throw new DOMException('The selected storage page changed','AbortError')
  return Response.json(result.body,{status:result.status})
}
export function useStorageTransport(){
  const scope=serverScope(usePathname()),serverId=scope.kind==='remote'?scope.id:undefined
  const request=useCallback((url:string,init?:RequestInit)=>scopedStorageFetch(serverId,url,init),[serverId])
  const root=serverId?`${serverOverview(serverId)}/storage`:'/storage'
  return{fetch:request,serverId,root,databaseHref:(id:string)=>`${root}/${encodeURIComponent(id)}`,appHref:(id:string)=>infrastructureAppHref(serverId,id,'storage')}
}
