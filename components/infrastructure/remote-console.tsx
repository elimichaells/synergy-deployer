'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {ConsoleTerminal} from '@/components/console-terminal'
import {ConsoleCommands} from '@/components/app/console-commands'
import {Button} from '@/components/ui/button'
import {Section} from '@/components/app/section'
import {completeCommand,projectQuickCommands} from '../../scripts/console-policy.cjs'
import type {ManagedServer} from '@/lib/managed-server-types'

type Info={entries:string[];scripts:Record<string,string>}
type Job={id:string;kind:string;status:string;log:string;cancel_requested:boolean;result?:{cwd?:string;console?:Info;inspection?:boolean};created_at:string}
export function RemoteConsole({server,appId,projectType,admin}:{server:ManagedServer;appId?:string;projectType?:string;admin:boolean}){
  const [command,setCommand]=useState(''),[cwd,setCwd]=useState('.'),[jobs,setJobs]=useState<Job[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false)
  const [history,setHistory]=useState<string[]>([]),[historyIndex,setHistoryIndex]=useState(-1),[cleared,setCleared]=useState(''),[completionOutput,setCompletionOutput]=useState('')
  const scope=`${server.id}/${appId||''}`,generation=useRef(scope),inspected=useRef(''),completed=useRef(''),pendingCompletion=useRef<{command:string;id:string}|null>(null)
  generation.current=scope
  const supported=server.metrics?.capabilities?.includes('remote-console-v1'),details=server.metrics?.capabilities?.includes('remote-console-details-v1'),url=`/api/servers/${server.id}/console`,commands=appId?projectQuickCommands(projectType||'node'):[]
  const load=useCallback(async()=>{if(!admin||!supported)return;try{const r=await fetch(url+(appId?'?appId='+appId:''),{cache:'no-store'}),v=await r.json();if(generation.current!==scope)return;if(!r.ok||!Array.isArray(v.jobs))throw Error(v.error||'Console history is unavailable');setJobs(v.jobs);setLoaded(true)}catch(e){if(generation.current===scope)setError((e as Error).message)}},[url,appId,admin,supported,scope])
  useEffect(()=>{setCommand('');setCwd('.');setJobs([]);setSelected('');setError('');setLoaded(false);setHistory([]);setHistoryIndex(-1);setCompletionOutput('');inspected.current='';completed.current='';pendingCompletion.current=null;void load();const timer=setInterval(()=>void load(),2000);return()=>clearInterval(timer)},[load])
  const active=jobs.find(job=>['queued','running'].includes(job.status)),shown=jobs.find(job=>job.id===selected)||jobs.find(job=>!job.result?.inspection)||jobs[0],information=jobs.find(job=>job.status==='success'&&job.result?.console)
  const applyCompletion=(text:string,info?:Info)=>{const result=completeCommand(text,info?.entries||[],commands,server.platform==='win32');setCommand(result.command);if(result.command===text&&result.matches.length>1)setCompletionOutput(result.matches.join('    ')+'\n')}
  useEffect(()=>{const latest=jobs[0];if(latest?.status==='success'&&latest.result?.cwd&&completed.current!==latest.id){completed.current=latest.id;setCwd(latest.result.cwd)}const pending=pendingCompletion.current;if(pending){const job=jobs.find(item=>item.id===pending.id);if(job&&['success','failed','cancelled'].includes(job.status)){pendingCompletion.current=null;if(job.result?.console&&command===pending.command)applyCompletion(command,job.result.console)}}},[jobs]) // Commands may be edited while an inspection is in flight.
  async function action(action:string,id?:string,requestedCommand=command){setBusy(true);setError('');try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id,appId,command:requestedCommand,cwd})}),v=await r.json();if(generation.current!==scope)return;if(!r.ok)throw Error(v.error||'Console operation failed');if(v.id)setSelected(v.id);if(action==='run'){setHistory(h=>[...h,requestedCommand].slice(-100));setHistoryIndex(-1);setCommand('');setCleared('');setCompletionOutput('')};await load();return v.id as string|undefined}catch(e){if(generation.current===scope)setError((e as Error).message)}finally{if(generation.current===scope)setBusy(false)}}
  useEffect(()=>{if(loaded&&details&&server.status==='online'&&!busy&&!active&&inspected.current!==scope){inspected.current=scope;if(!information)void action('inspect')}},[loaded,details,server.status,busy,active,scope,information])
  const complete=async()=>{if(!command.includes(' ')){applyCompletion(command);return}if(information?.result?.cwd===cwd){applyCompletion(command,information.result.console);return}const text=command,id=await action('inspect');if(id)pendingCompletion.current={command:text,id}}
  const disabled=busy||!!active||server.status!=='online',output=(cleared===shown?.id?'':shown?.log||'')+completionOutput
  return <Section title={appId?'Console':'Server console'} description={`Commands run inside ${appId?'this application':'the server console folder'} as the agent service account on ${server.name}, using its runtime versions and environment.`}>
    {!admin?<p className="text-sm text-muted-foreground">{appId?'Administrator or operator access is required to run application commands.':'Administrator access is required for server commands.'}</p>:!supported?<p className="text-sm text-muted-foreground">Update this server’s agent to enable console access.</p>:<div className="space-y-4">
      <ConsoleCommands commands={commands} scripts={information?.result?.console?.scripts||{}} disabled={disabled} onRun={value=>{setCommand(value);void action('run',undefined,value)}}/>
      <div className="flex flex-wrap items-end gap-3"><label className="flex-1 text-xs">Working directory<input className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm" value={cwd} onChange={e=>setCwd(e.target.value)} disabled={disabled}/></label>{details&&<Button variant="outline" disabled={disabled} onClick={()=>void action('inspect')}>Refresh commands</Button>}</div>
      {!details&&<p className="text-xs text-muted-foreground">Update the agent for package scripts, file completion and saved Git connections.</p>}
      {error&&<p role="alert" className="notice-error">{error}</p>}
      {jobs.length>0&&<label className="block text-xs">Operation<select className="ml-2 rounded border border-border bg-background p-2" value={shown?.id||''} onChange={e=>setSelected(e.target.value)}>{jobs.map(job=><option key={job.id} value={job.id}>{job.result?.inspection?'Command information':job.kind} · {job.status} · {new Date(job.created_at).toLocaleTimeString()}</option>)}</select></label>}
      <ConsoleTerminal title={`${server.platform==='win32'?'PowerShell':'Bash'} · ${server.name}`} cwd={cwd} command={command} onCommand={setCommand} output={output||null} outputText={output} running={!!active} disabled={busy||server.status!=='online'} onRun={()=>void action('run')} onStop={()=>{if(active&&!active.cancel_requested)void action('cancel',active.id)}} onClear={()=>{setCleared(shown?.id||'');setCompletionOutput('')}} onComplete={details?()=>void complete():undefined} onHistory={direction=>{const index=direction==='up'?Math.min(history.length-1,historyIndex+1):Math.max(-1,historyIndex-1);setHistoryIndex(index);setCommand(index>=0?history[history.length-1-index]:'')}}/>
      <p className="text-xs text-muted-foreground">One command at a time · 15 minute limit. Stop cancels the running process tree. Output is retained in operation history; do not print credentials.</p>
    </div>}
  </Section>
}
