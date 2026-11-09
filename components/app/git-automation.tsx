'use client'
import {useCallback,useEffect,useState} from 'react'
import Link from 'next/link'
import {Section} from './section'
import {Button} from '@/components/ui/button'
import {Switch} from '@/components/ui/switch'
type State={autoDeploy:boolean;hasSecret:boolean;webhookUrl:string;secret?:string;installed:boolean;hookError?:string}
export function GitAutomation({projectId,serverId,branch,autoDeploy,canWrite,productionId,onChanged}:{projectId:string;serverId?:string;branch:string;autoDeploy:boolean;canWrite:boolean;productionId?:string|null;onChanged?:()=>void}){
  const [data,setData]=useState<State>({autoDeploy,hasSecret:false,webhookUrl:'',installed:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[copied,setCopied]=useState('')
  const endpoint=serverId?`/api/servers/${serverId}/apps/${projectId}/git-automation`:`/api/projects/${projectId}/webhook`
  const load=useCallback(async()=>{
    if(!canWrite)return
    try{
      const response=await fetch(endpoint,{cache:'no-store'}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not read Git automation')
      if(serverId)setData(current=>({...current,...body}));else{const hook=await fetch(endpoint+'/git',{cache:'no-store'}),result=await hook.json();setData(current=>({...current,...body,autoDeploy,installed:!!result.installed,hookError:hook.ok?'':result.error}))}
      setLoaded(true);setError('')
    }catch(error){setError((error as Error).message)}
  },[endpoint,serverId,autoDeploy,canWrite])
  useEffect(()=>{setData(current=>({...current,autoDeploy}))},[autoDeploy])
  useEffect(()=>{void load()},[load])
  async function action(action:string,enabled?:boolean){
    if(action==='disconnect'&&!window.confirm('Disconnect this application’s Git webhook? Manual deployment remains available.'))return
    setBusy(true);setError('')
    try{
      const url=serverId?endpoint:action==='auto'?`/api/sites/${projectId}`:endpoint+(['connect','disconnect'].includes(action)?'/git':'')
      const response=await fetch(url,{method:serverId?'POST':action==='disconnect'?'DELETE':action==='auto'?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(serverId?{action,enabled}:action==='auto'?{autoDeploy:enabled}:{})}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not update Git automation')
      if(serverId)setData(current=>({...current,...body}));else{if(action==='auto')setData(current=>({...current,autoDeploy:!!enabled}));else await load()}
      onChanged?.()
    }catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  return <Section title="Git & automatic deploys" description={productionId&&!serverId?`Pushes to ${branch} deploy this staging copy. The webhook is managed on the production application.`:'Connect a Git webhook so pushes trigger deployments on this server.'}>
    <div className="space-y-4">
      <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-sm"><span><span className="block font-medium">Deploy on every push</span><span className="block text-xs text-muted-foreground">To <span className="font-mono">{branch}</span></span></span><Switch aria-label="Deploy on every push" checked={data.autoDeploy} disabled={!canWrite||busy||!loaded} onCheckedChange={enabled=>void action('auto',enabled)}/></label>
      {error&&<p role="alert" className="notice-error">{error}<Button variant="ghost" size="sm" onClick={()=>void load()}>Retry</Button></p>}
      {!canWrite?<p className="text-sm text-muted-foreground">An administrator can configure Git webhooks.</p>:productionId&&!serverId?<Button asChild variant="outline" size="sm"><Link href={`/sites/${productionId}?tab=settings`}>Open production webhook settings</Link></Button>:<>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm"><span>{!loaded?'Checking Git server…':data.installed?'Connected to Git server':data.hasSecret?'Not connected to Git server':'No webhook yet'}</span><Button size="sm" variant={data.installed?'outline':'default'} disabled={busy||!loaded} onClick={()=>void action(data.installed?'disconnect':'connect')}>{busy?'Saving…':data.installed?'Disconnect':'Connect'}</Button></div>
        {data.hookError&&<p role="alert" className="notice-error">{data.hookError}</p>}
        <details className="rounded-lg border border-border"><summary className="cursor-pointer px-4 py-2.5 text-xs text-muted-foreground">Manual webhook values</summary><div className="space-y-3 border-t border-border p-4">
          <p className="text-xs text-muted-foreground">Use JSON push events and keep certificate verification enabled. The Git server must be able to reach this Manager address.</p>
          {([['Payload URL',data.webhookUrl],['Secret',data.secret]] as const).map(([label,value])=><label key={label} className="field-label">{label}<div className="flex gap-2"><code className="min-w-0 flex-1 break-all rounded-md border border-border bg-well px-3 py-2 text-xs">{value||(data.hasSecret?'Stored securely':'Not configured')}</code><Button size="sm" variant="outline" disabled={!value} onClick={()=>{void navigator.clipboard.writeText(value||'').then(()=>setCopied(label))}}>{copied===label?'Copied':'Copy '+label}</Button></div></label>)}
          {!data.hasSecret&&<Button variant="outline" size="sm" disabled={busy||!loaded} onClick={()=>void action('generate')}>Generate secret</Button>}
        </div></details>
      </>}
    </div>
  </Section>
}
