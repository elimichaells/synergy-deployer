'use client'
import { useCallback,useEffect,useState } from 'react'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/app/section'
import type { ManagedServer } from '@/lib/managed-server-types'
type Job={id:string;kind:string;status:string;log:string;cancel_requested:boolean;result?:{cwd?:string};created_at:string}
export function RemoteConsole({server,appId,admin}:{server:ManagedServer;appId?:string;admin:boolean}){
  const [command,setCommand]=useState(''),[cwd,setCwd]=useState('.'),[jobs,setJobs]=useState<Job[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const supported=server.metrics?.capabilities?.includes('remote-console-v1'),url=`/api/servers/${server.id}/console`
  const load=useCallback(async()=>{if(!admin||!supported)return;try{const r=await fetch(url+(appId?'?appId='+appId:''),{cache:'no-store'}),v=await r.json();if(!r.ok)throw Error(v.error);setJobs(v.jobs)}catch(e){setError((e as Error).message)}},[url,appId,admin,supported])
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),2000);return()=>clearInterval(timer)},[load])
  const active=jobs.find(job=>['queued','running'].includes(job.status)),shown=jobs.find(job=>job.id===selected)||jobs[0]
  async function action(action:string,id?:string){setBusy(true);setError('');try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id,appId,command,cwd})}),v=await r.json();if(!r.ok)throw Error(v.error);if(v.id)setSelected(v.id);if(action==='run')setCommand('');await load()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Section title={appId?'Logs & console':'Server console'} description={`Commands run as the agent service account on ${server.name}. ${server.platform==='win32'?'PowerShell':'Bash'} · one command at a time · 15 minute limit.`}>
    {!admin?<p className="text-sm text-muted-foreground">Administrator access is required for remote commands and runtime logs.</p>:!supported?<p className="text-sm text-muted-foreground">Update this server’s agent to enable console access.</p>:<div className="space-y-4">
      <p className="text-xs text-muted-foreground">Commands can change files accessible to the agent. Application commands start in the deployed release. Output is retained in the operation history; do not print credentials. Stop cancels the running process tree.</p>
      <form className="space-y-3" onSubmit={e=>{e.preventDefault();void action('run')}}>
        <label className="block text-xs">Working directory (relative to {appId?'the current release':'the server console folder'})<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" value={cwd} onChange={e=>setCwd(e.target.value)} disabled={busy||!!active}/></label>
        <label className="block text-xs">Command<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" autoComplete="off" spellCheck={false} value={command} onChange={e=>setCommand(e.target.value)} disabled={busy||!!active} placeholder={server.platform==='win32'?'Get-Date':'date'}/></label>
        <div className="flex gap-2"><Button type="submit" disabled={busy||!!active||!command.trim()||server.status!=='online'}>Run command</Button>{appId&&<Button type="button" variant="outline" disabled={busy||!!active||server.status!=='online'} onClick={()=>void action('logs')}>Read runtime logs</Button>}{active&&<Button type="button" variant="outline" disabled={busy||active.cancel_requested} onClick={()=>void action('cancel',active.id)}>{active.cancel_requested?'Stopping…':'Stop'}</Button>}</div>
      </form>
      {error&&<p role="alert" className="notice-error">{error}</p>}
      {jobs.length>0&&<label className="block text-xs">Operation<select className="ml-2 rounded border border-border bg-background p-2" value={shown?.id||''} onChange={e=>setSelected(e.target.value)}>{jobs.map(job=><option key={job.id} value={job.id}>{job.kind} · {job.status} · {new Date(job.created_at).toLocaleTimeString()}</option>)}</select></label>}
      <pre aria-label="Console output" aria-live="polite" className="max-h-[32rem] min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-well p-4 font-mono text-xs">{shown?.log|| (active?'Waiting for the agent…':'Output will appear here.')}{shown&&`\n[${shown.status}]`}</pre>
    </div>}
  </Section>
}
