import { NextResponse } from 'next/server'
import { remoteSetupChecks } from '@/lib/remote-setup-policy'
import { SERVER_TOOLS } from '@/lib/server-tool-catalog'

const serverId = '11111111-1111-4111-8111-111111111111'
const windowsId = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const app: Record<string, any> = { id: appId, server_id: serverId, name: 'Campus Library', repo_url: 'https://github.com/example/library', branch: 'main', install_cmd: 'npm ci --include=dev', build_cmd: 'npm run build', start_cmd: 'npm start -- --hostname 127.0.0.1', port: 3100, health_path: '/health', access_mode: 'lan', hostname: 'library.campus.example.edu', ip_address: '192.168.10.20', ip_port: 8443, git_connection_id: null, env_names: ['DATABASE_URL'], live_commit: 'a'.repeat(40), deployed_at: new Date().toISOString() }
const metrics = { hostname: 'campus-linux', platform: 'linux', version: '1.7.0', capabilities: ['application-control-v1','guided-setup-v1','remote-infrastructure-v1','remote-resources-v1','remote-console-v1','runtime-versions-v1','agent-update-v1'], cpuPercent: 23, memoryTotal: 16 * 1024 ** 3, memoryFree: 10 * 1024 ** 3, diskTotal: 500 * 1024 ** 3, diskFree: 350 * 1024 ** 3, uptime: 864000, addresses: ['192.168.10.20'], tools: { node: 'v24.13.0', git: 'git version 2.50', pm2: '6.0', caddy: 'v2.10' }, apps: [{ id: appId, status: 'online', cpu: 4, memory: 256 * 1024 ** 2 }], proxyError: null }
const initial = { role: 'admin', servers: [
  { id: serverId, name: 'Main campus', location: 'Accra · institution LAN', platform: 'linux', enabled: true, enrolled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), metrics, status: 'online', app_count: 2, has_ca: true },
  { id: windowsId, name: 'Regional office', location: 'Kumasi · private network', platform: 'win32', enabled: true, enrolled_at: null, last_seen_at: null, metrics: null, status: 'pending', app_count: 0, has_ca: false },
], apps: [app, { ...app, id: '44444444-4444-4444-8444-444444444444', name: 'Student Records', port: 3200, hostname: 'records.campus.example.edu', ip_port: 8444, live_commit: null, deployed_at: null }], jobs: [
  { id: '55555555-5555-4555-8555-555555555555', app_id: appId, app_name: app.name, status: 'success', log: '[stage] checkout\n[stage] build\n[stage] health\n[stage] caddy\n[success] App healthy; routes loaded.', commit_sha: 'a'.repeat(40), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
] }
const state = (globalThis as unknown as { __remoteFixture?: typeof initial }).__remoteFixture ??= initial
const variables = (globalThis as unknown as { __remoteEnvFixture?: Record<string,Record<string,string>> }).__remoteEnvFixture ??= {}
const setupJobs = (globalThis as unknown as { __remoteSetupJobsFixture?: Record<string,any>[] }).__remoteSetupJobsFixture ??= []
const updateFixture = (globalThis as unknown as { __agentUpdateFixture?: Record<string,any> }).__agentUpdateFixture ??= {}

// Synthetic UI fixture only. No database, filesystem mutation or network agents.
export async function remoteServersFixture(request: Request) {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith('/api/servers')) return null
  const parts = pathname.slice('/api/servers'.length).split('/').filter(Boolean)
  if(parts[1]==='apps'&&parts[3]==='env'){
    const selected=state.apps.find(a=>a.id===parts[2]&&a.server_id===parts[0]);if(!selected)return NextResponse.json({error:'Application not found'},{status:404})
    selected.envFiles??={'.env':'# Base settings\nGREETING=hello\n','.env.local':'# Local settings\nGREETING=campus\n'}
    if(request.method==='POST'){const body=await request.json();if(body.previousContent!==selected.envFiles[body.file])return NextResponse.json({error:'File changed elsewhere'},{status:409});selected.envFiles[body.file]=body.content;return NextResponse.json({ok:true})}
    const file=new URL(request.url).searchParams.get('file')||'.env';return NextResponse.json({file,content:selected.envFiles[file]||''})
  }
  if(parts[1]==='apps'&&parts[3]==='git-automation')return NextResponse.json({autoDeploy:false,hasSecret:false,webhookUrl:'https://manager.example/api/webhooks/remote/'+parts[0]+'/'+parts[2],installed:false})
  if(parts[1]==='deployments')return NextResponse.json({jobs:state.jobs.filter(job=>state.apps.some(app=>app.server_id===parts[0]&&app.id===job.app_id)),next:null})
  if(parts[1]==='apps'&&parts[3]==='security-gate')return NextResponse.json({gate:{off:false,indefinite:false,until:null,reason:null,by:null,at:null},canTurnOff:state.role==='admin'})
  if(parts[1]==='apps'&&parts[3]==='removal'){
    const selected=state.apps.find(a=>a.id===parts[2]&&a.server_id===parts[0]);if(!selected)return NextResponse.json({error:'Application not found'},{status:404})
    if(request.method==='DELETE'){const body=await request.json();if(body.confirmationName!==selected.name||!body.acknowledged)return NextResponse.json({error:'Review and confirm removal'},{status:400});state.apps=state.apps.filter(a=>a.id!==selected.id);return NextResponse.json({ok:true})}
    return NextResponse.json({application:{id:selected.id,name:selected.name,environment:'production',serverId:parts[0]},domains:[selected.hostname],related:[],queuedJobs:0,requiresAgent:!!selected.live_commit,blockers:[],reviewToken:'synthetic-app-review'})
  }
  if(parts[1]==='apps'&&parts[3]==='related'){
    const selected=state.apps.find(a=>a.id===parts[2]);if(!selected)return NextResponse.json({error:'Application not found'},{status:404})
    if(request.method==='PATCH'){const body=await request.json();selected.group_name=body.name}
    return NextResponse.json({production_id:selected.id,application_group_id:selected.id,group_name:selected.group_name||selected.name,component_role:'application',canWrite:state.role!=='viewer',members:[{...selected,environment:'production',database_count:1}],candidates:state.apps.filter(a=>a.id!==selected.id),domains:[],routes:[],sharedDatabases:[]})
  }
  if(parts[1]==='domains'&&parts[2]==='routes')return NextResponse.json({routes:[]})
  if(request.method==='PATCH' && parts.length===1) {
    if(state.role!=='admin')return NextResponse.json({error:'Forbidden'},{status:403})
    const server=state.servers.find(item=>item.id===parts[0]),body=await request.json()
    if(!server)return NextResponse.json({error:'Server not found'},{status:404})
    if(server.name!==body.previousName)return NextResponse.json({error:'The server name changed. Refresh and try again.'},{status:409})
    if(typeof body.name!=='string'||!body.name.trim()||body.name.length>100||/[\x00-\x1f]/.test(body.name))return NextResponse.json({error:'Invalid server name'},{status:400})
    server.name=body.name.trim();return NextResponse.json({id:server.id,name:server.name})
  }
  if(parts[1]==='removal') {
    const server=state.servers.find(item=>item.id===parts[0])
    if(!server)return NextResponse.json({error:'Server not found'},{status:404})
    const applications=state.apps.filter(item=>item.server_id===server.id),requiresConfirmation=!!server.enrolled_at||!!applications.length
    const review={server:{...server,enrolled:!!server.enrolled_at},applications:applications.map(item=>({...item,environment_name:'production'})),domains:[],queuedOperations:0,history:{jobs:1,agentUpdates:0,serviceOperations:0},requiresConfirmation,blockers:[],reviewToken:'synthetic-review'}
    if(request.method==='GET')return NextResponse.json(review)
    if(request.method==='DELETE'){
      const body=await request.json()
      if(body.reviewToken!==review.reviewToken || (requiresConfirmation && (body.confirmationName!==server.name||body.acknowledged!==true)))return NextResponse.json({error:'Review and confirm removal'},{status:400})
      state.servers=state.servers.filter(item=>item.id!==server.id);state.apps=state.apps.filter(item=>item.server_id!==server.id)
      return NextResponse.json({ok:true})
    }
  }
  if(parts[1]==='infrastructure') {
    if(parts[2]==='services')return NextResponse.json([{id:appId,name:'manager-remote-fixture',displayName:app.name,status:'online',uptime:Date.now()-86400000,cpu:4,memory:256,restarts:1}])
    if(parts[2]==='caddy'&&request.method==='POST'){const body=await request.json();return NextResponse.json(body.action==='read-config'?{ok:true,config:'{\n  \"apps\": {}\n}',configSize:16,configReadAt:new Date().toISOString(),configPath:'Active Caddy configuration (JSON)'}:{ok:true,valid:true,output:'Synthetic validation passed'})}
    if(parts[2]==='caddy')return NextResponse.json({mode:'shared',status:'running',configPath:'/etc/caddy/Caddyfile',version:'2.10'})
    if(parts[2]==='health') {
      if(parts[3]==='history')return NextResponse.json({range:'24h',from:Date.now()-86400000,to:Date.now(),intervalMs:300000,summary:{passed:1400,failed:2,unknown:1,paused:0,successPercent:99.86,averageMs:26},services:[],points:[],unavailable:false,stale:false,startedAt:Date.now()-86400000,checkedAt:Date.now()})
      return NextResponse.json({checkedAt:new Date().toISOString(),stale:false,unavailable:false,incidents:[],snapshot:{disks:[{name:'Application disk',total:500*1024**3,free:350*1024**3}],memory:{total:16*1024**3,free:10*1024**3},pm2Updates:0,pm2Error:false,collectorError:null,apps:[{name:app.name,status:'online',restarts:1}],checks:[{name:app.name,ok:true,status:200,ms:26}]}})
    }
  }
  if(parts[1]==='console')return NextResponse.json({jobs:[{id:'fixture-console',kind:'console',status:'success',log:'Synthetic preview: command completed.\n',created_at:new Date().toISOString(),result:{cwd:'/var/lib/manager-agent/console'}}]})
  if(parts[1]==='services')return NextResponse.json({operations:[]})
  if(parts[1]==='domains')return NextResponse.json({domains:[{id:appId,project_id:appId,project_name:app.name,environment:'production',hostname:app.hostname,record_type:'A',record_content:'192.168.10.20',dns_status:'manual',ssl_status:'Route loaded',application_route:true,proxied:false,is_primary:true}]})
  if(parts[1]==='runtimes') {
    if(parts[2]==='versions')return NextResponse.json({installed:['22.23.4'],available:[{version:'22.23.4',label:'Node.js 22.23.4 LTS'},{version:'24.22.2',label:'Node.js 24.22.2 LTS'}]})
    return NextResponse.json({runtimes:[{id:'node',name:'Node.js',purpose:'JavaScript runtime',installed:true,version:'v24.22.1',canInstall:true,canUpdate:true,canConfigure:true,versioned:true,installedVersions:['22.23.4'],updateAvailable:true,latestVersion:'24.22.2',updateMode:'project-version',installSource:'Selected remote server'},{id:'postgresql',name:'PostgreSQL',purpose:'Database server',installed:false,version:null,canInstall:true,installedVersions:[],versioned:false}]})
  }
  if (parts.length===2 && parts[1]==='agent-update') {
    const server = state.servers.find(item=>item.id===parts[0])
    if(!server)return NextResponse.json({error:'Server not found'},{status:404})
    if(request.method==='GET')return NextResponse.json({installed:server.metrics?.version,available:'1.7.0',supported:!!server.enrolled_at,updateAvailable:server.metrics?.version!=='1.7.0',latest:updateFixture[server.id] || null})
    const body=await request.json()
    if(body.action==='cancel'){if(updateFixture[server.id])updateFixture[server.id].status='cancelled';return NextResponse.json({ok:true})}
    updateFixture[server.id]={id:crypto.randomUUID(),from_version:server.metrics?.version,target_version:'1.7.0',status:'queued',message:'Preview only: waiting for the agent to become idle. No server will be updated.',updated_at:new Date().toISOString()}
    return NextResponse.json({id:updateFixture[server.id].id},{status:202})
  }
  if (request.method === 'GET') {
    if(parts[1]==='apps' && ['setup','environment'].includes(parts[3])) {
      const target=state.apps.find(item=>item.id===parts[2] && item.server_id===parts[0])
      if(!target)return NextResponse.json({error:'Application not found'},{status:404})
      if(parts[3]==='environment')return NextResponse.json({environment:variables[target.id] || {}})
      return NextResponse.json({app:target,related:state.apps.filter(item=>item.id===(target.production_id||target.id)||item.production_id===(target.production_id||target.id)),jobs:setupJobs.filter(job=>job.app_id===target.id),checks:remoteSetupChecks(target as Parameters<typeof remoteSetupChecks>[0])})
    }
    for (const server of state.servers) if (server.status === 'online') server.last_seen_at = new Date().toISOString()
    if (!parts.length) return NextResponse.json({ servers: state.servers, role: state.role, userId: 'fixture-user', local: { hostname: 'synergy-manager', platform: 'win32' } })
    const apps = state.apps.filter(a => a.server_id === parts[0])
    return NextResponse.json({ server: state.servers.find(s => s.id === parts[0]), apps, jobs: state.jobs.filter(job => apps.some(app => app.id === job.app_id)), role: state.role })
  }
  const body = await request.json()
  if(parts[1]==='apps' && parts[2]==='import') {
    const environments=body.environmentMode==='production-staging'?['production','staging']:[body.environmentMode]
    const ids=environments.map(()=>crypto.randomUUID())
    for(let index=0;index<environments.length;index++) {
      const id=ids[index], framework=body.repo_url.includes('payments-api')?'go':'next', platform=state.servers.find(item=>item.id===parts[0])?.platform
      const commands=framework==='go'?{install_cmd:'go mod download',build_cmd:`go build -o ${platform==='win32'?'app.exe':'app'} .`,start_cmd:platform==='win32'?'.\\app.exe':'./app'}:{install_cmd:'npm ci --include=dev',build_cmd:'npm run build',start_cmd:'npm start'}
      state.apps.push({...app,...commands,id,name:body.name,repo_url:body.repo_url,branch:index===1?body.stagingBranch:body.branch,server_id:parts[0],environment_name:environments[index],production_id:index===1?ids[0]:null,guided_setup:true,project_type:framework,port:3500+state.apps.length,hostname:`app-${id}.invalid`,ip_address:'',ip_port:null,env_names:[],live_commit:null,deployed_at:null,setup_step:'runtime',setup_decisions:{},setup_completed_at:null,database_config:null,inspection:{framework,commit:'c'.repeat(40),commands,packageManager:framework==='go'?null:'npm',tools:{...metrics.tools,npm:'11',go:'go1.25',php:'8.4',composer:'2',psql:'18',mysql:'8.4',mariadb:'11'}}})
      setupJobs.unshift({id:crypto.randomUUID(),app_id:id,kind:'inspect',status:'success',log:'[preview] Repository inspected. No server was contacted.',created_at:new Date().toISOString()})
    }
    return NextResponse.json({id:ids[0],apps:ids.map((id,index)=>({id,environment:environments[index]}))})
  }
  if(parts[1]==='apps' && parts[3]==='setup') {
    const target=state.apps.find(item=>item.id===parts[2] && item.server_id===parts[0])!
    if(body.action==='save') {
      for(const key of ['project_type','install_cmd','build_cmd','start_cmd','port','health_path','access_mode','hostname','ip_address','ip_port'])if(Object.hasOwn(body,key))target[key]=body[key]
      target.setup_completed_at=null; target.setup_step=body.step
      if(body.environment){variables[target.id]=body.environment;target.env_names=Object.keys(body.environment)}
      if(body.environmentReviewed)target.setup_decisions.environment='reviewed'
      if(body.domainConfigured)target.setup_decisions.domain='configured'
      if(body.databaseNone){target.database_config=null;target.setup_decisions.database='none'}
    } else if(body.action==='progress')target.setup_step=body.step
    else if(body.action==='database') {
      target.database_config={provider:body.provider||'postgresql',host:body.host||'127.0.0.1',port:body.port||5432,database:body.database||'library_fixture',username:body.username||'library_user',status:'ready',tls:false};target.setup_decisions.database='configured'
    } else if(body.action==='validate')target.setup_completed_at=new Date().toISOString()
    if(body.action!=='save'&&body.action!=='progress')setupJobs.unshift({id:crypto.randomUUID(),app_id:target.id,kind:body.action,status:'success',log:'[preview] Operation completed using synthetic data.',created_at:new Date().toISOString()})
    return NextResponse.json({ok:true})
  }
  if (parts[0] === '__fixture') {
    if (['admin', 'operator', 'viewer'].includes(body.role)) state.role = body.role
    const server = state.servers.find(item => item.id === body.serverId)
    if (server && ['online', 'offline', 'pending', 'revoked'].includes(body.status)) {
      server.status = body.status
      if (body.status === 'online') { server.enrolled_at = new Date().toISOString(); server.metrics = { ...metrics, platform: server.platform, hostname: server.platform === 'win32' ? 'regional-windows' : 'campus-linux', apps: server.id === serverId ? metrics.apps : [] } }
    }
    return NextResponse.json({ ok: true })
  }
  if (!parts.length) {
    const id = crypto.randomUUID()
    state.servers.push({ ...state.servers[1], ...body, id, app_count: 0, enrolled_at: null, last_seen_at: null, metrics: null, status: 'pending', has_ca: false })
    return NextResponse.json({ id, enrollmentToken: 'fixture-token-for-preview-only', expiresInMinutes: 60 })
  }
  if (parts[1] === 'ssh') {
    if (body.action === 'probe') return NextResponse.json({ fingerprint: 'SHA256:PreviewOnlyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    const server = state.servers.find(s => s.id === parts[0])!
    if (body.action === 'inspect') {
      const win = server.platform === 'win32'
      const versions: Record<string,string> = { node: 'v24.13.0', git: 'git version 2.50.0', caddy: 'v2.10.0', pm2: '6.0.0', psql: 'psql (PostgreSQL) 18.1', pg_dump: 'pg_dump (PostgreSQL) 18.1', pg_restore: 'pg_restore (PostgreSQL) 18.1', mysql: 'mysql Ver 8.4.0' }
      return NextResponse.json({inventory:{ platform:server.platform,arch:'x64',privileged:true,portsKnown:true,ports:[22,5432,3306],services:[{name:win?'postgresql-x64-18':'postgresql.service',status:'Running',executable:win?'D:\\Databases\\PostgreSQL\\bin\\pg_ctl.exe':'/usr/lib/postgresql/18/bin/postgres',config:win?'E:\\Database Data\\PostgreSQL':'/var/lib/postgresql/18/main'}],tools:Object.fromEntries(SERVER_TOOLS.map(tool=>[tool.id,versions[tool.id] || body.paths?.[tool.id] ? [{path:body.paths?.[tool.id] || (win ? tool.id==='pm2'?'D:\\Tools\\node_modules\\pm2\\bin\\pm2':`D:\\Tools\\${tool.id}\\${tool.id}.exe`:`/opt/tools/${tool.id}/bin/${tool.id}`),version:versions[tool.id] || 'custom version',compatible:!body.paths?.[tool.id]?.includes('missing'),error:body.paths?.[tool.id]?.includes('missing')?'File not found':undefined}]:[]]))}})
    }
    server.enrolled_at = new Date().toISOString(); server.last_seen_at = server.enrolled_at; server.status = 'online'
    server.metrics = { ...metrics, platform: server.platform, hostname: 'regional-windows', addresses: [body.host], apps: [] }
    return NextResponse.json({ online: true, message: 'Preview: agent installed and reporting to Manager.', log: '[preview] Synthetic SSH setup only. No server was contacted.\n[setup] Identity checked\n[setup] Tools installed\n[setup] Agent reporting' })
  }
  if (parts.length === 1 && body.action === 'enrollment') return NextResponse.json({ enrollmentToken: 'fixture-token-for-preview-only' })
  if (parts[1] === 'apps' && parts.length === 2) {
    const id = crypto.randomUUID()
    state.apps.push({ ...app, ...body, id, server_id: parts[0], port: Number(body.port), ip_port: Number(body.ip_port), env_names: Object.keys(body.environment || {}), live_commit: null, deployed_at: null })
    return NextResponse.json({ id })
  }
  if (parts[1] === 'apps' && parts.length === 3) {
    const target = state.apps.find(item => item.id === parts[2] && item.server_id === parts[0])
    if (!target) return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    const { environment, ...config } = body
    Object.assign(target, config)
    if (environment !== undefined) { variables[target.id] = environment; target.env_names = Object.keys(environment) }
    return NextResponse.json({ id: target.id })
  }
  if (parts[3] === 'deploy') {
    const target = state.apps.find(a => a.id === parts[2])!
    const id = crypto.randomUUID()
    state.jobs.unshift({ ...state.jobs[0], id, app_id: target.id, app_name: target.name, status: 'queued', log: '' })
    return NextResponse.json({ id })
  }
  return NextResponse.json({ ok: true })
}
