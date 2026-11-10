'use client'
import { useEffect,useState } from 'react'
import { DeploymentHistory } from '@/components/workspace/deployment-history'
import { Button } from '@/components/ui/button'
import { remoteDeployment } from '@/lib/remote-workspace'
import type {RemoteApp,RemoteJob} from '@/lib/managed-server-types'
type Props={serverId:string;appId?:string;groupId?:string;apps:RemoteApp[];initial:RemoteJob[];now:number}
export function RemoteDeploymentHistory(props:Props){return <ScopedDeploymentHistory key={[props.serverId,props.appId,props.groupId].join(':')} {...props}/>}
function ScopedDeploymentHistory({serverId,appId,groupId,apps,initial,now}:Props){
  const [jobs,setJobs]=useState(initial.filter(job=>!appId||job.app_id===appId)),[next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const endpoint=`/api/servers/${serverId}/deployments${appId?'?app='+appId:groupId?'?group='+groupId:''}`
  useEffect(()=>{const controller=new AbortController();const read=async()=>{try{const response=await fetch(endpoint,{cache:'no-store',signal:controller.signal}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not load deployment history');if(controller.signal.aborted)return;setJobs(body.jobs);setNext(body.next);setError('')}catch(error){if(!controller.signal.aborted)setError((error as Error).message)}};void read();return()=>controller.abort()},[endpoint])
  useEffect(()=>{setJobs(current=>{const map=new Map(current.map(job=>[job.id,job]));for(const job of initial)if(!appId||job.app_id===appId)map.set(job.id,job);return [...map.values()].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))})},[initial,appId])
  async function more(){setBusy(true);try{const response=await fetch(`${endpoint}${appId||groupId?'&':'?'}before=${next}`,{cache:'no-store'}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not load older deployments');setJobs(current=>[...current,...body.jobs.filter((job:RemoteJob)=>!current.some(item=>item.id===job.id))]);setNext(body.next);setError('')}catch(error){setError((error as Error).message)}finally{setBusy(false)}}
  return <div className="space-y-4">{error&&<p role="alert" className="notice-error">{error}</p>}<DeploymentHistory deployments={jobs.filter(job=>apps.some(app=>app.id===job.app_id)).map(job=>remoteDeployment(job,apps))} now={now} projectsHref={`/infrastructure/servers/${serverId}#applications`}/>{next&&<Button variant="outline" disabled={busy} onClick={()=>void more()}>{busy?'Loading…':'Load older deployments'}</Button>}</div>
}
