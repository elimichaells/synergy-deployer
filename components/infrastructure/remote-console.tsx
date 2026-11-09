'use client'
import { useCallback,useEffect,useRef,useState } from 'react'
import { ConsoleTerminal } from '@/components/console-terminal'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/app/section'
import type { ManagedServer } from '@/lib/managed-server-types'
type Job={id:string;kind:string;status:string;log:string;cancel_requested:boolean;result?:{cwd?:string};created_at:string}
export function RemoteConsole({server,appId,admin}:{server:ManagedServer;appId?:string;admin:boolean}){
  const [command,setCommand]=useState(''),[cwd,setCwd]=useState('.'),[jobs,setJobs]=useState<Job[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [history,setHistory]=useState<string[]>([]),[historyIndex,setHistoryIndex]=useState(-1),[cleared,setCleared]=useState('')
  const supported=server.metrics?.capabilities?.includes('remote-console-v1'),url=`/api/servers/${server.id}/console`
  const load=useCallback(async()=>{if(!admin||!supported)return;try{const r=await fetch(url+(appId?'?appId='+appId:''),{cache:'no-store'}),v=await r.json();if(!r.ok)throw Error(v.error);setJobs(v.jobs)}catch(e){setError((e as Error).message)}},[url,appId,admin,supported])
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),2000);return()=>clearInterval(timer)},[load])
  const completed=useRef('')
  useEffect(()=>{const latest=jobs[0];if(latest?.status==='success'&&latest.result?.cwd&&completed.current!==latest.id){completed.current=latest.id;setCwd(latest.result.cwd)}},[jobs])
  const active=jobs.find(job=>['queued','running'].includes(job.status)),shown=jobs.find(job=>job.id===selected)||jobs[0]
  async function action(action:string,id?:string){setBusy(true);setError('');try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id,appId,command,cwd})}),v=await r.json();if(!r.ok)throw Error(v.error);if(v.id)setSelected(v.id);if(action==='run'){setHistory(h=>[...h,command].slice(-100));setHistoryIndex(-1);setCommand('');setCleared('')};await load()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Section title={appId?'Application console':'Server console'} description={`Commands run as the agent service account on ${server.name}. ${server.platform==='win32'?'PowerShell':'Bash'} · one command at a time · 15 minute limit.`}>
    {!admin?<p className="text-sm text-muted-foreground">{appId?'Administrator or operator access is required to run application commands.':'Administrator access is required for server commands.'}</p>:!supported?<p className="text-sm text-muted-foreground">Update this server’s agent to enable console access.</p>:<div className="space-y-4">
      <p className="text-xs text-muted-foreground">Commands can change files accessible to the agent. Application commands start in the deployed release. Output is retained in the operation history; do not print credentials. Stop cancels the running process tree.</p>
      <div className="flex flex-wrap items-end gap-3"><label className="flex-1 text-xs">Working directory<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" value={cwd} onChange={e=>setCwd(e.target.value)} disabled={busy||!!active}/></label>{appId&&<Button variant="outline" disabled={busy||!!active||server.status!=='online'} onClick={()=>void action('logs')}>Read runtime logs</Button>}</div>
      {error&&<p role="alert" className="notice-error">{error}</p>}
      {jobs.length>0&&<label className="block text-xs">Operation<select className="ml-2 rounded border border-border bg-background p-2" value={shown?.id||''} onChange={e=>setSelected(e.target.value)}>{jobs.map(job=><option key={job.id} value={job.id}>{job.kind} · {job.status} · {new Date(job.created_at).toLocaleTimeString()}</option>)}</select></label>}
      <ConsoleTerminal title={`${server.platform==='win32'?'PowerShell':'Bash'} · ${server.name}`} cwd={shown?.result?.cwd||cwd} command={command} onCommand={setCommand} output={cleared===shown?.id?null:shown?.log||'Output will appear here.'} outputText={cleared===shown?.id?'':shown?.log||''} running={!!active} disabled={busy||server.status!=='online'} onRun={()=>void action('run')} onStop={()=>{if(active&&!active.cancel_requested)void action('cancel',active.id)}} onClear={()=>setCleared(shown?.id||'')} onHistory={direction=>{const index=direction==='up'?Math.min(history.length-1,historyIndex+1):Math.max(-1,historyIndex-1);setHistoryIndex(index);setCommand(index>=0?history[history.length-1-index]:'')}}/>

    </div>}
  </Section>
}
