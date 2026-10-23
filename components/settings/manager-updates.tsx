'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, CheckCircle2, Download, History, Loader2, RefreshCw, ShieldCheck, Undo2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UpdateState } from '@/scripts/manager-update-state.cjs'

type Status = { version: string; configured: boolean; assetName: string; maintenance?: boolean; job: UpdateState | null; history: UpdateState[]; recoveryDirectory?: string }
type Release = { version: string; available: boolean; newer: boolean; url: string; notes: string }
const active = ['queued','draining','stopping','activating','checking','rolling_back','rollback_requested']
const labels: Record<string,string> = { preparing:'Preparing package',ready:'Ready to install',queued:'Waiting to install',draining:'Waiting for active work',stopping:'Creating recovery backup',activating:'Installing release',checking:'Checking Manager',succeeded:'Update complete',rolling_back:'Restoring previous release',rollback_requested:'Waiting to recover',rolled_back:'Previous release restored',failed:'Update stopped',recovery_failed:'Recovery needs attention' }

export function ManagerUpdates({isAdmin}:{isAdmin:boolean}) {
  const [status,setStatus]=useState<Status|null>(null),[release,setRelease]=useState<Release|null>(null)
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[reconnecting,setReconnecting]=useState(false)
  const [file,setFile]=useState<File|null>(null),[progress,setProgress]=useState<number|null>(null)
  const fileInput=useRef<HTMLInputElement>(null)
  const load=useCallback(async()=>{
    if(!isAdmin)return
    try {
      const r=await fetch('/api/manager-updates',{cache:'no-store'}),body=await r.json()
      if(!r.ok)throw new Error(body.error||'Unable to read update status')
      setStatus(body);setReconnecting(false)
    } catch {setReconnecting(true)}
  },[isAdmin])
  useEffect(()=>{void load();const timer=setInterval(()=>void load(),4000);return()=>clearInterval(timer)},[load])
  async function action(name:string) {
    setBusy(name);setError('')
    try {
      const r=await fetch('/api/manager-updates'+(name==='check'?'?check=1':''),name==='check'?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:name,id:status?.job?.id})})
      const b=await r.json();if(!r.ok)throw new Error(b.error||'Update action failed')
      if(name==='check')setRelease(b)
      await load()
    }catch(e){setError((e as Error).message)}finally{setBusy('')}
  }
  async function upload() {
    if(!file)return;setBusy('upload');setProgress(0);setError('')
    try {
      await new Promise<void>((resolve,reject)=>{
        const xhr=new XMLHttpRequest();xhr.open('POST','/api/manager-updates');xhr.timeout=30*60_000
        xhr.setRequestHeader('Content-Type','application/octet-stream')
        xhr.upload.onprogress=e=>{if(e.lengthComputable)setProgress(Math.round(e.loaded/e.total*100))}
        xhr.onload=()=>{let b;try{b=JSON.parse(xhr.responseText)}catch{b={error:'Upload response was interrupted. Check update status before retrying.'}};xhr.status>=200&&xhr.status<300?resolve():reject(new Error(b.error||'Upload failed'))}
        xhr.onerror=()=>reject(new Error('Upload connection failed'));xhr.ontimeout=()=>reject(new Error('Upload timed out'));xhr.send(file)
      })
      setFile(null);if(fileInput.current)fileInput.current.value='';await load()
    }catch(e){setError((e as Error).message)}finally{setBusy('');setProgress(null)}
  }
  if(!isAdmin)return <p className="text-sm text-muted-foreground">An administrator can install Manager updates and manage recovery.</p>
  const job=status?.job, working=!!job&&active.includes(job.phase), blocked=!!busy||working||!!job&&['preparing','ready','recovery_failed'].includes(job.phase)
  const newer=release?.newer && release.version!==status?.version
  return <div className="space-y-7">
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-white/[0.02] p-5">
      <div><p className="text-xs text-muted-foreground">Installed version</p><p className="mt-1 text-2xl font-semibold tracking-tight">{status?'v'+status.version:'Loading…'}</p><p className="mt-2 text-xs text-muted-foreground">Stable releases from elimichaells/synergy-deployer</p></div>
      <Button variant="outline" disabled={!status?.configured||blocked} onClick={()=>void action('check')}><RefreshCw className={`mr-2 h-4 w-4 ${busy==='check'?'animate-spin':''}`}/>Check for updates</Button>
    </div>
    {reconnecting&&<p role="status" className="text-sm text-amber-400">{working?'Manager is restarting. This page will reconnect automatically.':'Waiting for Manager. Retrying the connection…'}</p>}
    {error&&<p role="alert" className="notice-error">{error}</p>}
    {status&&!status.configured&&<div className="notice-error"><p className="font-medium">One-time setup required</p><p className="mt-2 text-sm">Run <code>scripts/install-manager-updater.ps1</code> as an administrator on this Manager server. This registers recovery so it can run even when Manager is offline.</p></div>}
    {release&&<div className="rounded-xl border border-border p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{newer?'Available release v'+release.version:'You are up to date'}</h3>{newer&&!release.available&&<p className="mt-2 text-sm text-amber-400">This release has no compatible update package for this server.</p>}</div><a href={release.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary">View release<ArrowUpRight className="h-4 w-4"/></a></div>{release.notes&&<details className="mt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Release notes</summary><p className="mt-3 whitespace-pre-wrap break-words leading-6">{release.notes}</p></details>}{release.available&&newer&&<Button className="mt-4" disabled={blocked} onClick={()=>void action('download')}><Download className="mr-2 h-4 w-4"/>{busy==='download'?'Downloading and verifying…':'Download update'}</Button>}</div>}
    {job&&<section aria-label="Current update" className="rounded-xl border border-border p-5">
      <div className="flex items-center gap-3">{working||job.phase==='preparing'?<Loader2 className="h-5 w-5 animate-spin text-primary"/>:job.phase==='succeeded'?<CheckCircle2 className="h-5 w-5 text-emerald-400"/>:<ShieldCheck className="h-5 w-5 text-muted-foreground"/>}<div><h3 className="font-semibold">{labels[job.phase]||job.phase}</h3><p className="mt-1 text-xs text-muted-foreground">{job.version?'v'+job.fromVersion+' → v'+job.version:'Package verification'} · {job.source==='offline'?'Offline package':job.source==='local'?'Local bootstrap release':'GitHub release'}</p></div></div>
      <ol className="mt-4 space-y-2 border-l border-border pl-4">{job.events.slice(-6).map((e,i)=><li key={e.at+i} className="text-sm text-muted-foreground"><span className="mr-2 text-xs tabular-nums">{new Date(e.at).toLocaleTimeString()}</span>{e.message}</li>)}</ol>
      {job.phase==='ready'&&<div className="mt-5 space-y-3"><p className="text-sm text-muted-foreground">Installation backs up Manager and briefly restarts it. Running applications stay online. If checks fail, the previous release is restored automatically.</p><div className="flex gap-2"><Button disabled={!!busy} onClick={()=>void action('install')}><Download className="mr-2 h-4 w-4"/>Install update</Button><Button variant="outline" disabled={!!busy} onClick={()=>void action('cancel')}>Discard package</Button></div></div>}
      {job.phase==='succeeded'&&<details className="mt-5"><summary className="cursor-pointer text-sm text-muted-foreground">Recovery options</summary><p className="mt-3 text-sm text-muted-foreground">Return Manager to v{job.fromVersion}. Manager will restart. Compatible database additions and changes made since the update are kept; the database snapshot remains available for manual recovery.</p><Button className="mt-3" variant="outline" disabled={!!busy} onClick={()=>void action('rollback')}><Undo2 className="mr-2 h-4 w-4"/>Restore previous release</Button></details>}
      {job.phase==='recovery_failed'&&<div className="mt-4"><p className="text-sm text-amber-400">Maintenance stays enabled until recovery succeeds. The protected recovery folder contains the backup and the full operation history.</p><Button variant="outline" className="mt-3" disabled={!!busy} onClick={()=>void action('recover')}>Retry recovery</Button></div>}
      {job.phase==='preparing'&&Date.now()-Date.parse(job.updatedAt)>35*60_000&&<Button className="mt-4" variant="outline" onClick={()=>void action('cancel')}>Cancel interrupted preparation</Button>}
    </section>}
    <section className="rounded-xl border border-border p-5"><div className="flex items-center gap-2"><Upload className="h-4 w-4 text-muted-foreground"/><h3 className="font-semibold">Offline update</h3></div><p className="mt-2 text-sm leading-6 text-muted-foreground">Download the update package on a connected computer, then bring it to this institution. Publisher verification and installation work without internet access.</p><p className="mt-3 break-all font-mono text-xs text-muted-foreground">{status?.assetName||'manager-update-… .tar'}</p><div className="mt-4 flex flex-wrap items-center gap-3"><input ref={fileInput} type="file" accept=".tar" aria-label="Offline update package" disabled={!status?.configured||blocked} onChange={e=>setFile(e.target.files?.[0]||null)} className="min-w-0 max-w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border file:border-border file:bg-transparent file:px-3 file:py-2 file:text-foreground"/><Button variant="outline" disabled={!file||!status?.configured||blocked} onClick={()=>void upload()}>{busy==='upload'?<Loader2 className="mr-2 h-4 w-4 animate-spin"/>:<ShieldCheck className="mr-2 h-4 w-4"/>}Verify package</Button></div>{progress!==null&&<p role="status" className="mt-3 text-xs text-muted-foreground">{progress<100?`Uploading ${progress}%`:'Upload complete. Verifying publisher and staging the release…'}</p>}</section>
    {!!status?.history.length&&<section><h3 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4"/>Update history</h3><div className="mt-3 divide-y divide-border">{status.history.slice(0,5).map(h=><div key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span>{h.version?'v'+h.version:'Package import'}<span className="ml-3 text-xs text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</span></span><span className="text-xs text-muted-foreground">{labels[h.phase]||h.phase}</span></div>)}</div></section>}
    <p className="text-xs leading-5 text-muted-foreground">Updates cover Manager. Database engines, Node.js and remote agents are managed separately. Recovery copies stay on the server until an administrator archives them.{status?.recoveryDirectory&&<span className="mt-1 block break-all font-mono">{status.recoveryDirectory}</span>}</p>
  </div>
}
