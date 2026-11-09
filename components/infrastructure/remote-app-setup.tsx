'use client'
import { DeploymentScript } from '@/components/app/deployment-script'

import { ChoiceCard } from '@/components/app/section'
import { EnvironmentSettings } from '@/components/app/environment-settings'
import { SetupSteps } from '@/components/setup-steps'
import { FrameworkLogo } from '@/components/synergy/framework-logo'
import { Button } from '@/components/ui/button'
import { environmentText, parseEnvironmentText } from '@/lib/environment-text'
import type { ManagedServer, RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { SETUP_STEPS, type SetupCheck, type SetupStep } from '@/lib/project-setup-policy'
import { PROJECT_TYPES } from '@/lib/project-types'
import { REMOTE_FRAMEWORKS, type RemoteFramework, type RemoteInspection } from '@/lib/remote-setup-policy'
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, Rocket } from 'lucide-react'
import Link from 'next/link'
import { RemoteRuntimeSelection } from './remote-runtime-selection'
import { RemoteAddressFields } from './remote-address-fields'
import { useCallback, useEffect, useRef, useState } from 'react'

type Database = { status: string; provider: string; host: string; port: number; database: string; username: string; tls: boolean }
type App = RemoteApp & { project_type: RemoteFramework | null; setup_step: SetupStep; setup_decisions: Record<string,string>; inspection: RemoteInspection | null; database_config: Database | null }
type Snapshot = { app: App; related: Pick<App,'id'|'name'|'environment_name'|'setup_completed_at'>[]; jobs: RemoteJob[]; checks: SetupCheck[] }
const headings: Record<SetupStep,string> = {repository:'Import the source',runtime:'Build settings',database:'Database',environment:'Environment variables',domain:'Domain',review:'Ready to deploy'}

export function RemoteAppSetup({ server, appId, canWrite, canDeploy, onChanged, onDeploy, onDirtyChange, section }: {
  section?: SetupStep; server: ManagedServer; appId: string; canWrite: boolean; canDeploy: boolean; onChanged: () => void; onDeploy: () => Promise<void>; onDirtyChange: (dirty:boolean) => void
}) {
  const endpoint=`/api/servers/${server.id}/apps/${appId}`
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null), [step,setStep]=useState<SetupStep>('repository')
  const [form,setForm]=useState({runtime_versions:{} as Record<string,string>,deploy_script:'',project_type:'next' as RemoteFramework,install_cmd:'',build_cmd:'',start_cmd:'',port:'3000',health_path:'/',access_mode:'lan' as 'lan'|'wan',hostname:'',ip_address:'',ip_port:'8443'})
  const [database,setDatabase]=useState({mode:'none',serviceOperationId:'',provider:'postgresql',host:'127.0.0.1',port:'5432',database:'',username:'',password:'',adminUsername:'postgres',adminPassword:'',tls:false})
  const [installedServices,setInstalledServices]=useState<{id:string;service_id:string;result:{port:number};status:string}[]>([])
  useEffect(()=>{if(!canWrite)return;void fetch(`/api/servers/${server.id}/services`,{cache:'no-store'}).then(r=>r.json()).then(v=>setInstalledServices((v.operations||[]).filter((o:{status:string;service_id:string;result?:{username?:string}})=>o.status==='success'&&['postgresql','mysql','mariadb'].includes(o.service_id)&&o.result?.username))).catch(()=>{})},[server.id,canWrite])
  const [environment,setEnvironment]=useState(''), [envLoaded,setEnvLoaded]=useState(false)
  const [branch,setBranch]=useState('main')
  const [saved,setSaved]=useState(false)
  const [busy,setBusy]=useState(false), [dirty,setDirty]=useState(false), [error,setError]=useState('')
  const initialized=useRef(false), inspected=useRef(false)
  const load=useCallback(async()=>{
    const response=await fetch(endpoint+'/setup',{cache:'no-store'}), result=await response.json()
    if(!response.ok)throw new Error(result.error || 'Could not load application setup')
    const data=result as Snapshot;setSnapshot(data)
    if(!initialized.current || (!inspected.current && data.app.inspection)) {
      const app=data.app
      setForm({deploy_script:app.deploy_script||'',runtime_versions:app.runtime_versions||{},project_type:app.project_type || 'next',install_cmd:app.install_cmd,build_cmd:app.build_cmd,start_cmd:app.start_cmd,port:String(app.port),health_path:app.health_path,access_mode:app.access_mode,hostname:app.hostname.endsWith('.invalid')?'':app.hostname,ip_address:app.ip_address,ip_port:String(app.ip_port || 8443)})
      setStep(section || app.setup_step);setBranch(app.branch);inspected.current=!!app.inspection
      if(app.database_config)setDatabase(current=>({...current,mode:'existing',...app.database_config,port:String(app.database_config!.port)}))
      initialized.current=true
    }
    return data
  },[endpoint,section])
  useEffect(()=>{void load().catch(error=>setError(error.message));const timer=setInterval(()=>void load().catch(error=>setError(error.message)),5000);return()=>clearInterval(timer)},[load])
  useEffect(()=>{if(dirty)setSaved(false);onDirtyChange(dirty);return()=>onDirtyChange(false)},[dirty,onDirtyChange])
  const active=snapshot?.jobs.find(job=>job.status==='running'||job.status==='queued')
  const locked=busy||!!active||!canWrite||!server.enabled
  const app=snapshot?.app
  function update(values:Partial<typeof form>) {setForm(current=>({...current,...values}));setDirty(true)}
  function updateDatabase(values:Partial<typeof database>) {setDatabase(current=>({...current,...values}));setDirty(true)}
  async function post(body:object) {
    const response=await fetch(endpoint+'/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const result=await response.json();if(!response.ok)throw new Error(result.error || 'Setup action failed')
    await load();onChanged();return result
  }
  async function run(action:()=>Promise<void>) {setBusy(true);setError('');try{await action()}catch(error){setError((error as Error).message)}finally{setBusy(false)}}
  async function save(next:SetupStep) {
    if(step==='repository' && dirty)throw new Error('Re-inspect the selected branch before continuing')
    if(step==='runtime')await post({action:'save',step:next,runtime_versions:form.runtime_versions,deploy_script:form.deploy_script,project_type:form.project_type,install_cmd:form.install_cmd,build_cmd:form.build_cmd,start_cmd:form.start_cmd,port:form.port,health_path:section?undefined:form.health_path})
    else if(step==='environment') {
      if(dirty)throw new Error('Save the environment file before continuing')
      await post({action:'save',step:next,environmentReviewed:true})
    } else if(step==='domain')await post({action:'save',step:next,access_mode:form.access_mode,hostname:form.hostname,ip_address:form.ip_address,ip_port:form.ip_port,domainConfigured:true})
    else if(step==='database') {
      if(database.mode==='none')await post({action:'save',step:next,databaseNone:true})
      else {if(dirty || app?.database_config?.status!=='ready')throw new Error('Save and test this database connection first');await post({action:'progress',step:next})}
    } else await post({action:'progress',step:next})
    setDirty(false);setStep(next);setSaved(true)
  }
  function navigate(next:SetupStep) {
    if(!canWrite){setStep(next);return}
    void run(async()=>{if(dirty || ['runtime','environment','database','domain'].includes(step))await save(next);else {await post({action:'progress',step:next});setStep(next)}})
  }
  function chooseFramework(value:RemoteFramework) {
    const runner=app?.inspection?.packageManager || 'npm'
    const install=app?.inspection?.commands.install_cmd.startsWith(`${runner} `) ? app.inspection.commands.install_cmd : runner==='pnpm'?'pnpm install --prod=false':runner==='yarn'?'yarn install':'npm install --include=dev'
    const defaults:Record<RemoteFramework,{install_cmd:string;build_cmd:string;start_cmd:string}>={
      next:{install_cmd:install,build_cmd:`${runner} run build`,start_cmd:`${runner} run start`},node:{install_cmd:install,build_cmd:app?.inspection?.commands.build_cmd || '',start_cmd:`${runner} run start`},
      angular:{install_cmd:install,build_cmd:`${runner} run build`,start_cmd:'@manager/static'},
      go:{install_cmd:'go mod download',build_cmd:`go build -o ${server.platform==='win32'?'app.exe':'app'} .`,start_cmd:server.platform==='win32'?'.\\app.exe':'./app'},
      laravel:{install_cmd:'composer install --no-dev --optimize-autoloader',build_cmd:'php artisan config:cache',start_cmd:`php artisan serve --host=127.0.0.1 --port=${form.port} --no-reload`},
    }
    update({project_type:value,...(value===app?.inspection?.framework?app.inspection.commands:defaults[value])})
  }
  if(!snapshot||!app)return <div role="status" className="py-12 text-center text-sm text-muted-foreground">{error||'Loading application setup…'}</div>
  const index=SETUP_STEPS.indexOf(step)
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"><div><p className="text-sm font-medium">{app.name} <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{app.environment_name==='staging'?'Staging':'Production'}</span></p><p className="mt-1 text-xs text-muted-foreground">{server.name} · {server.platform==='win32'?'Windows':'Linux'} · {app.branch}</p></div><div className="flex flex-wrap gap-2">{snapshot.related.filter(item=>item.id!==appId).map(item=><Link key={item.id} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent" href={`/infrastructure/servers/${server.id}?tab=setup#app-${item.id}`}>Open {item.environment_name} setup</Link>)}</div></div>
    {error&&<p role="alert" className="notice-error">{error}</p>}
    {active&&<p role="status" className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{active.kind==='inspect'?'Inspecting repository':active.kind==='database'?'Setting up database':active.kind==='validate'?'Checking this server':'Deploying'} · {active.status==='queued'?'waiting for the agent':'running on '+server.name}{active.status==='queued'&&canWrite&&<Button variant="outline" size="sm" className="ml-auto" onClick={()=>void run(async()=>{const response=await fetch(`/api/servers/${server.id}/jobs/${active.id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const result=await response.json();if(!response.ok)throw new Error(result.error);await load()})}>Cancel queued job</Button>}</p>}
    <div className={section ? 'min-w-0' : 'grid min-w-0 gap-8 lg:grid-cols-[220px_minmax(0,1fr)]'}>
      {!section && <aside className="space-y-5"><SetupSteps step={step} onSelect={navigate} disabled={busy||!!active} completed={app.setup_completed_at?[...SETUP_STEPS]:app.inspection?['repository']:[]} /><p className="hidden break-all text-xs leading-5 text-muted-foreground lg:block">{app.repo_url}<br />Port {app.port}<br />Progress is saved for this environment.</p></aside>}
      <section className="min-w-0 space-y-5" aria-label={headings[step]}>
        <div>{!section && <p className="eyebrow">Step {index+1} of {SETUP_STEPS.length}</p>}<h2 className="text-2xl font-semibold tracking-tight">{headings[step]}</h2></div>
        {step==='repository'&&<div className="space-y-4 rounded-xl border border-border bg-card p-5"><p className="break-all text-sm font-medium">{app.repo_url}</p><label className="field-label">Branch<input disabled={locked} className="control-input font-mono" value={branch} onChange={event=>{setBranch(event.target.value);setDirty(true)}} /></label><p className="text-sm text-muted-foreground">Branch {app.branch} is cloned on {server.name}. Inspection reads manifests and does not execute repository scripts.</p>{app.inspection&&<p className="flex items-center gap-2 text-sm text-status-ready"><CheckCircle2 className="h-4 w-4" />{app.inspection.framework?`${PROJECT_TYPES[app.inspection.framework].label} detected`:'Choose the framework in Build settings'} · {app.inspection.commit.slice(0,12)}</p>}<Button disabled={locked} variant="outline" onClick={()=>void run(async()=>{await post({action:'inspect',branch});inspected.current=false;setDirty(false)})}>{app.inspection?'Re-inspect repository':'Clone and inspect'}</Button></div>}
        {step==='runtime'&&<fieldset disabled={locked} className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Framework">{REMOTE_FRAMEWORKS.map(type=><ChoiceCard key={type} title={PROJECT_TYPES[type].label} description={app.inspection?.framework===type?'Detected from this repository':'Use these build defaults'} icon={<FrameworkLogo type={type} className="h-5 w-5" />} selected={form.project_type===type} onSelect={()=>chooseFramework(type)} />)}</div>
          <div className="rounded-lg border border-border bg-card p-4"><p className="text-sm font-medium">Tools on {server.name}</p><div className="mt-2 flex flex-wrap gap-2">{Object.entries(app.inspection?.tools||{}).filter(([tool])=>['node','git','pm2','caddy',app.inspection?.packageManager,form.project_type==='go'?'go':'',...(form.project_type==='laravel'?['php','composer']:[])].includes(tool)).map(([tool,value])=><span key={tool} className={`rounded-md border border-border px-2 py-1 text-xs ${value?'text-muted-foreground':'text-status-failed'}`}>{tool}: {value||'missing'}</span>)}</div><p className="mt-2 text-xs text-muted-foreground">Install missing tools for the agent account, then re-inspect. The final checks verify availability again.</p></div>
          <RemoteRuntimeSelection serverId={server.id} value={form.runtime_versions} onChange={runtime_versions=>update({runtime_versions})}/>
          <DeploymentScript value={form.deploy_script} onChange={deploy_script=>update({deploy_script})}/>
          {(['install_cmd','build_cmd','start_cmd'] as const).map((key,i)=><label key={key} className="field-label">{['Install command','Build command','Start command'][i]}<input className="control-input font-mono" value={form[key]} onChange={event=>update({[key]:event.target.value})} /></label>)}
          {form.start_cmd==='@manager/static'&&<p className="text-xs text-muted-foreground">Synergy serves the built Angular site from dist with SPA routing. For SSR, enter your server start command.</p>}
          <div className="grid gap-4 sm:grid-cols-2"><label className="field-label">Application port<input type="number" min={1024} max={65535} className="control-input" value={form.port} onChange={event=>update({port:event.target.value,...(form.project_type==='laravel'&&form.start_cmd.startsWith('php artisan serve ')?{start_cmd:`php artisan serve --host=127.0.0.1 --port=${event.target.value} --no-reload`}:{})})} /></label>{!section&&<label className="field-label">Health check path<input className="control-input" value={form.health_path} onChange={event=>update({health_path:event.target.value})} /><span className="text-xs text-muted-foreground">Uses the application readiness settings. The default accepts HTTP 2xx and local redirects.</span></label>}</div>
        </fieldset>}
        {step==='database'&&<fieldset disabled={locked} className="space-y-5">
          <p className="text-sm text-muted-foreground">Connections are tested from {server.name}. A new database gets a separate app account and generated password for this environment.</p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Database setup">{[['none','No database','This app does not need a database.'],['create','Create new','Create a database on an installed database server.'],['existing','Use existing','Connect using an existing application account.']].map(([mode,title,description])=><ChoiceCard key={mode} selected={database.mode===mode} disabled={form.project_type==='angular'&&mode!=='none'} title={title} description={description} onSelect={()=>updateDatabase({mode})} />)}</div>
          {form.project_type==='angular'&&<p className="text-xs text-muted-foreground">Browser applications connect through your backend API; database secrets must stay on the backend.</p>}
          {app.database_config&&<div className="rounded-lg border border-border bg-card p-4 text-sm"><p className="font-medium">Saved database · {app.database_config.status}</p><p className="mt-1 break-all text-xs text-muted-foreground">{app.database_config.provider} · {app.database_config.host}:{app.database_config.port} · {app.database_config.database} · {app.database_config.username}</p><Button type="button" size="sm" variant="outline" className="mt-3" onClick={()=>void run(async()=>{await post({action:'database',mode:'retry'});setDirty(false);setDatabase(current=>({...current,mode:'existing',password:'',adminPassword:''}))})}>Test saved connection</Button><p className="mt-2 text-xs text-muted-foreground">After an interrupted creation, test the saved credential before retrying. Choosing No database detaches it; it never deletes data.</p></div>}
          <p className="text-xs text-muted-foreground">Missing a database engine? <Link className="underline" href={`/infrastructure/servers/${server.id}?section=runtimes#server-access`}>Install or reuse services</Link> on this server.</p>
          {database.mode==='create'&&installedServices.length>0&&<label className="field-label">Database installation<select className="control-input" value={database.serviceOperationId} onChange={e=>{const item=installedServices.find(s=>s.id===e.target.value);updateDatabase({serviceOperationId:e.target.value,...(item?{provider:item.service_id,host:'127.0.0.1',port:String(item.result.port),adminUsername:'',adminPassword:''}:{})})}}><option value="">Provide existing administrator credentials</option>{installedServices.map(s=><option key={s.id} value={s.id}>{s.service_id} · 127.0.0.1:{s.result.port} · managed by Manager</option>)}</select>{database.serviceOperationId&&<span className="text-xs text-muted-foreground">Manager supplies the protected installation credential when creating this application’s database.</span>}</label>}
          {database.mode!=='none'&&<>
            <div className="grid gap-4 sm:grid-cols-2"><label className="field-label">Database engine<select className="control-input" disabled={database.mode==='create'&&!!database.serviceOperationId} value={database.provider} onChange={event=>updateDatabase({provider:event.target.value,port:event.target.value==='postgresql'?'5432':'3306',adminUsername:event.target.value==='postgresql'?'postgres':'root'})}>{['postgresql','mysql','mariadb'].map(provider=><option key={provider}>{provider}</option>)}</select></label><label className="field-label">Database host<input className="control-input" disabled={database.mode==='create'&&!!database.serviceOperationId} value={database.host} onChange={event=>updateDatabase({host:event.target.value})} /></label><label className="field-label">Database port<input type="number" min={1} max={65535} className="control-input" disabled={database.mode==='create'&&!!database.serviceOperationId} value={database.port} onChange={event=>updateDatabase({port:event.target.value})} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={database.mode==='create'&&!!database.serviceOperationId} checked={database.tls} onChange={event=>updateDatabase({tls:event.target.checked})} />Verify database TLS certificate and hostname</label>
              {database.mode==='create'?<><label className="field-label">Administrator username<input autoComplete="off" className="control-input" disabled={!!database.serviceOperationId} value={database.adminUsername} onChange={event=>updateDatabase({adminUsername:event.target.value})} /></label><label className="field-label">Administrator password<input type="password" autoComplete="new-password" className="control-input" disabled={!!database.serviceOperationId} value={database.adminPassword} onChange={event=>updateDatabase({adminPassword:event.target.value})} /></label></>:<><label className="field-label">Database name<input className="control-input" value={database.database} onChange={event=>updateDatabase({database:event.target.value})} /></label><label className="field-label">Application username<input autoComplete="off" className="control-input" value={database.username} onChange={event=>updateDatabase({username:event.target.value})} /></label><label className="field-label">Application password<input type="password" autoComplete="new-password" className="control-input" value={database.password} onChange={event=>updateDatabase({password:event.target.value})} /></label></>}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">Requires {database.provider==='postgresql'?'psql':database.provider} on the agent account’s PATH and a running database service. TLS uses that client’s trusted CA configuration. MySQL/MariaDB creation uses this server’s loopback address. No engine is installed or exposed through the firewall by this step.</p>
            <Button type="button" onClick={()=>void run(async()=>{await post({action:'database',...database});setDatabase(current=>({...current,password:'',adminPassword:''}));setDirty(false)})}>{database.mode==='create'?'Create and test database':'Save and test connection'}</Button>
          </>}
        </fieldset>}
        {step==='environment'&&<EnvironmentSettings projectId={appId} serverId={server.id} canWrite={!locked} browserApp={app.project_type==='angular'} onDirtyChange={setDirty} onSaved={()=>void load()}/>}
        {step==='domain'&&<fieldset disabled={locked}><RemoteAddressFields value={form} onChange={update} serverId={server.id}/></fieldset>}
        {step==='review'&&<div className="space-y-4"><p className="text-sm text-muted-foreground">Review this environment, then check the target server before deploying.</p><div className="divide-y divide-border rounded-xl border border-border bg-card">{snapshot.checks.map(check=><div key={check.id} className="p-4"><p className={`text-sm font-medium ${check.status==='pass'?'text-status-ready':'text-status-failed'}`}>{check.status==='pass'?'✓':'•'} {check.label}</p><p className="mt-1 text-xs text-muted-foreground">{check.detail}</p></div>)}</div><p className="break-all text-sm">{app.environment_name} · {app.branch} · https://{app.hostname} · port {app.port}</p><p className="text-xs leading-5 text-muted-foreground">Deployment installs dependencies, builds, activates and checks the app. A failed activation restores the previous release. Database migrations and external data changes are not reversed by an app rollback.</p><div className="flex flex-wrap gap-2"><Button disabled={locked||snapshot.checks.some(check=>check.status==='fail')} variant="outline" onClick={()=>void run(async()=>{await post({action:'validate'})})}>Run server checks</Button><Button disabled={!canDeploy||busy||!!active||!app.setup_completed_at||!server.enabled} onClick={()=>void run(onDeploy)}><Rocket className="mr-2 h-4 w-4" />Deploy {app.environment_name}</Button></div>{app.setup_completed_at&&<p role="status" className="text-sm text-status-ready">Server checks passed. This environment is ready to deploy.</p>}</div>}
        {section && saved && <p role="status" className="text-sm text-status-ready">Changes saved. Run the checks in Setup before deploying.</p>}
        {section ? <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5"><Button disabled={locked} onClick={() => void run(() => save(step))}>Save changes</Button><p className="text-xs text-muted-foreground">After changes, run the checks in Setup before deploying.</p></div> : <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-5"><Button disabled={busy||!!active||index===0} variant="outline" onClick={()=>navigate(SETUP_STEPS[index-1])}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>{index<SETUP_STEPS.length-1&&<Button disabled={busy||!!active||(step==='repository'&&!app.inspection)} onClick={()=>navigate(SETUP_STEPS[index+1])}>{canWrite?'Save and continue':'Continue'}<ArrowRight className="ml-2 h-4 w-4" /></Button>}</div>}

      </section>
    </div>
    {!!snapshot.jobs.length&&<details className="rounded-xl border border-border bg-card p-4" open={!!active || snapshot.jobs[0].status==='failed' || undefined}><summary className="cursor-pointer text-sm font-medium">Setup activity</summary><div className="mt-3 space-y-3">{snapshot.jobs.slice(0,5).map(job=><div key={job.id}><p className="text-xs font-medium">{job.kind} · {job.status} · {new Date(job.created_at).toLocaleString()}</p><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-well p-3 font-mono text-xs leading-5">{job.log||'Waiting for the agent…'}</pre></div>)}</div></details>}
  </div>
}
