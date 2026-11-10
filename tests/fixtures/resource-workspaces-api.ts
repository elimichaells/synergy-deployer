import { NextResponse } from 'next/server'
const appId='33333333-3333-4333-8333-333333333333'
type State={enabled:boolean;history:any[];cron:any[];workers:any[];limit:number|null}
const states=new Map<string,State>()
export async function resourceWorkspacesFixture(request:Request,role:string) {
  const url=new URL(request.url),match=/^\/api\/servers\/([^/]+)\/resources(.*)$/.exec(url.pathname),scope=match?.[1]||'local'
  const aliases:Record<string,string>={'/api/services':'/services','/api/system/caddy':'/caddy','/api/server/memory':'/memory','/api/server/databases':'/databases','/api/operations':'/operations','/api/automation/cron':'/automation/cron','/api/automation/workers':'/automation/workers'}
  const route=match?.[2]||aliases[url.pathname];if(!route)return null
  const state=states.get(scope)||{enabled:false,history:[],cron:[],workers:[],limit:null};states.set(scope,state)
  const remote=scope!=='local',label=remote?'Campus Library':'Customer portal',root=remote?'/var/lib/manager-agent':'C:\\web',now=new Date().toISOString(),json=NextResponse.json
  if(route==='/services')return json([{id:appId,name:'fixture',displayName:label,status:'online',uptime:Date.now()-86400000,cpu:4,memory:256,restarts:1}])
  if(route==='/caddy'){if(url.searchParams.get('includeConfig')==='1')return json({config:'{\n  \"apps\": {}\n}',configSize:16,configReadAt:now});if(request.method==='POST'){const body=await request.json();return json(body.action==='read-config'?{ok:true,config:'{\n  \"apps\": {}\n}',configSize:16,configReadAt:now,configPath:'Active Caddy configuration (JSON)'}:{ok:true,valid:true,output:'Synthetic validation passed'})}return json({mode:remote?'shared':'service',status:'running',configPath:remote?'/etc/caddy/Caddyfile':'C:\\Caddy\\Caddyfile',version:'2.10'})}
  if(route==='/memory')return json({role,stale:false,notes:[],snapshot:{takenAt:now,totalMb:16384,availableMb:10240,commitMb:6144,commitLimitMb:20480,pageFileMb:4096,pageFileUsedMb:200,apps:[{name:'fixture',projectId:appId,label,environment:'production',privateMb:512,processes:4,limitMb:state.limit,peakMb:650}],others:[{name:'postgres',count:9,privateMb:384},{name:'caddy',count:1,privateMb:64}]},history:Array.from({length:24},(_,i)=>({takenAt:new Date(Date.now()-(24-i)*3600000).toISOString(),availableMb:9000+Math.sin(i)*1000,commitMb:7000})),alerts:[],thresholds:{lowMemoryMb:1638,buildMinFreeMb:1638,buildConcurrency:1},startMethods:[{projectId:appId,label,environment:'production',state:'eligible',overheadMb:96,reason:null}],staging:[]})
  if(route==='/databases'||route==='/databases/inspect')return json({ok:true,canTune:role==='admin',servers:[{connectionId:appId,name:'Application PostgreSQL',engine:'postgresql',port:5432,version:'18.1',memoryMb:384,service:'postgresql',dataMb:128,databases:3,connections:{total:8,idle:4,groups:[]},apps:[label],recommendations:[],notes:[],error:null}]})
  if(route==='/apps')return json([{id:appId,name:label,environment:'production',project_type:'node',root_path:root+'/releases/app'}])
  if(route.startsWith('/apps/')){
    const body=await request.json().catch(()=>({}))
    if(route.endsWith('/health'))return json({ok:true,profile:{path:'/health',statuses:[],timeoutMs:60000,...body},stale:false,checkedAt:now,application:{health:'healthy'}})
    if(route.endsWith('/logs'))return json({ok:true,log:request.method==='DELETE'?'':'[application] Listening on port 3100\n[application] Ready for requests',logPath:root+'/pm2/logs/application-'+url.searchParams.get('type')+'.log'})
    if(route.endsWith('/memory')){if(request.method==='GET')return json({memory:{running:true,usageMb:512,peakMb:650,limitMb:state.limit,processes:4,serverTotalMb:16384,suggestedMb:1024,alerts:[]}});state.limit=body.limitMb}
    if(route.endsWith('/sleep')&&request.method==='GET')return json({sleep:{minutes:null,sleepingSince:null,lastActiveAt:now}})
    return json({ok:true,healthy:true,limitMb:state.limit,minutes:body.minutes})
  }
  if(route==='/disk'){
    if(request.method==='POST'){const body=await request.json();if(body.action==='settings')state.enabled=body.enabled;else{const entries=[{path:root+'/releases/current',name:'Current deployment',bytes:2*1024**3,eligible:false,reason:'Current application reference'},{path:root+'/releases/expired',name:'Expired failed build',bytes:1024**3,eligible:true,reason:'Outside the three-day retention period'}];state.history.unshift({id:String(Date.now()),mode:body.action,source:'manual',status:'success',started_at:now,finished_at:now,report:{projects:[{projectName:label,entries,warnings:[]}],warnings:[],eligibleBytes:1024**3,retainedBytes:2*1024**3,removedBytes:body.action==='clean'?1024**3:0,removed:body.action==='clean'?[{path:entries[1].path}]:[]}})}return json({ok:true})}
    return json({enabled:state.enabled,role,history:state.history,stale:false,capable:true,volumes:[{path:root,locations:[root],free:350*1024**3,total:500*1024**3}]})
  }
  if(route==='/operations') {
    if(request.method==='POST'){const body=await request.json();if(body.action==='prepare-recovery')return NextResponse.json({error:'This application is healthy. Recovery is not eligible.'},{status:409});if(body.action==='database-review')return json({database:{projectName:label,files:[],missing:[],services:[],warnings:[],nextSteps:['Open storage to configure a database'],limitations:'Synthetic preview only',href:remote?`/infrastructure/servers/${scope}#storage`:'/storage'}});return json({settings:{enabled:false,configured:false,model:'',recoveryEnabled:true}})}
    return json({diagnosis:{source:'rules',summary:'No active alerts in the latest monitoring evidence.',evidence:[],recommendations:['observe'],limitations:['Local rules are available without an AI connection.']},settings:{enabled:false,configured:false,model:'',recoveryEnabled:true},role,checkedAt:now,stale:false,apps:[{id:appId,name:label,pm2_name:'fixture'}],mapping:[],uptime:{range:'24h',from:Date.now()-86400000,to:Date.now(),startedAt:Date.now()-86400000,checkedAt:Date.now(),unavailable:false,stale:false,services:[]},history:[]})
  }
  if(route.startsWith('/automation/')){
    const parts=route.split('/'),kind=parts[2]==='cron'?'cron':'workers',list=state[kind]
    if(parts[4]==='logs')return json({ok:true,output:'Synthetic worker output'})
    if(request.method==='GET')return json(list)
    const body=await request.json().catch(()=>({})),id=parts[3]||crypto.randomUUID(),existing=list.find(x=>x.id===id)
    if(request.method==='DELETE'){state[kind]=list.filter(x=>x.id!==id);return json({ok:true})}
    if(parts[4]){if(existing)existing.status=parts[4]==='stop'?'stopped':'online';return json({ok:true})}
    const value={...existing,...body,id,project_id:body.projectId||null,project_name:label,project_type:'node',working_directory:body.workingDirectory,timeout_seconds:body.timeoutSeconds,pm2_name:body.pm2Name||'fixture-worker',status:body.enabled?'online':'stopped',last_status:'idle',next_run_at:now,last_started_at:null,last_finished_at:null,last_exit_code:null,last_output:null,pid:null,uptime:null,restarts:0,cpu:0,memory:0};if(existing)Object.assign(existing,value);else list.push(value);return json({ok:true})
  }
  return json({error:'Unknown synthetic resource request'},{status:404})
}
