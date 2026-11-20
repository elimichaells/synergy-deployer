'use client'

import {useState} from 'react'
import {useRouter} from 'next/navigation'
import {ArrowUpRight} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {PromoteSheet} from '@/components/app/promote-sheet'
import type {RemoteApp,RemoteJob} from '@/lib/managed-server-types'

export function RemotePromotion({serverId,app,apps,jobs,disabled,onChanged}:{serverId:string;app:RemoteApp;apps:RemoteApp[];jobs:RemoteJob[];disabled:boolean;onChanged:()=>void}){
  const [open,setOpen]=useState(false),router=useRouter()
  const production=apps.find(item=>item.server_id===serverId&&item.id===app.production_id)
  if(app.environment_name!=='staging'||!app.production_id)return null
  const same=!!app.live_commit&&app.live_commit===production?.live_commit
  const active=jobs.some(job=>[app.id,app.production_id].includes(job.app_id)&&['queued','running'].includes(job.status))
  return <>
    <Button variant="outline" size="sm" disabled={disabled||active||same||!production} title={same?'Production already runs this commit':'Review what would be released, then promote it'} onClick={()=>setOpen(true)}><ArrowUpRight className="mr-1.5 h-3.5 w-3.5"/>Promote to production</Button>
    <PromoteSheet key={app.id} stagingId={app.id} serverId={serverId} open={open} onOpenChange={setOpen} onStarted={deploymentId=>{setOpen(false);onChanged();router.push(`/infrastructure/servers/${serverId}?view=${deploymentId}#deployments`)}}/>
  </>
}
